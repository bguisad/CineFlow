/**
 * ItemCF 离线计算与二进制工件存取
 * 相似度: 共现经 IUF 加权后按流行度平方根惩罚(缓解热门偏向), 每片保留 top-K 近邻
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { eventWeight } from './profile.js';
import { readHeader, readTyped, writeHeader, typedBuffer } from '../store/binary.js';
/**
 * 计算流行度(交互用户数 + 时间衰减分) —— ItemCF 惩罚项与热门兜底路共用
 */
export function buildPopularity(events, now, tauHours) {
    const map = new Map();
    for (const e of events) {
        if (e.type === 'imp' || e.type === 'dislike')
            continue;
        let entry = map.get(e.itemId);
        if (!entry) {
            entry = { count: 0, score: 0, lastTs: 0 };
            map.set(e.itemId, entry);
        }
        entry.count += 1;
        const dtH = Math.max(0, (now - (e.ts ?? now)) / 3_600_000);
        entry.score += Math.exp(-dtH / tauHours);
        entry.lastTs = Math.max(entry.lastTs, e.ts ?? 0);
    }
    return map;
}
/**
 * ItemCF 相似度离线计算(标准 ItemCF + IUF + 流行度惩罚):
 *   sim(i,j) = Σ_u [1/log(1+|I_u|)] / sqrt(pop_i * pop_j)
 * 每用户参与共现的条目数截断到 cap, 控制长尾用户计算量。
 */
export function computeItemCF(events, itemIds, now, cfg) {
    const n = itemIds.length;
    const k = Math.min(cfg.itemcfNeighbors, Math.max(1, n - 1));
    const idxOf = new Map();
    for (let i = 0; i < n; i++)
        idxOf.set(itemIds[i], i);
    // user -> {itemId: 聚合权重}
    const userItems = new Map();
    for (const e of events) {
        if (e.type === 'imp' || !idxOf.has(e.itemId))
            continue;
        const w = eventWeight(e, cfg);
        if (w <= 0)
            continue;
        let m = userItems.get(e.userId);
        if (!m) {
            m = new Map();
            userItems.set(e.userId, m);
        }
        m.set(e.itemId, Math.max(m.get(e.itemId) ?? 0, w));
    }
    // 流行度(交互人数), 用于惩罚
    const pop = new Float64Array(n);
    for (const m of userItems.values())
        for (const id of m.keys())
            pop[idxOf.get(id)] += 1;
    // 共现: co(i,j) += IUF(u)
    const cap = 300; // 单用户截断, 防超长历史拖爆共现计算
    const co = new Map(); // key = i*n + j (i<j)
    for (const m of userItems.values()) {
        if (m.size < 2)
            continue;
        const items = [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, cap)
            .map(([id]) => idxOf.get(id));
        const iuf = 1 / Math.log(1 + items.length);
        for (let a = 0; a < items.length; a++) {
            for (let b = a + 1; b < items.length; b++) {
                const i = items[a];
                const j = items[b];
                if (i === j)
                    continue;
                const key = i * n + j;
                co.set(key, (co.get(key) ?? 0) + iuf);
            }
        }
    }
    // 惩罚 + 每 item 的 top-K 邻接表
    const byItem = new Map();
    for (const [key, c] of co) {
        const i = Math.floor(key / n);
        const j = key % n;
        const denom = Math.sqrt(pop[i] * pop[j]);
        if (denom <= 0)
            continue;
        const sim = c / denom;
        (byItem.get(i) ?? byItem.set(i, []).get(i)).push([j, sim]);
        (byItem.get(j) ?? byItem.set(j, []).get(j)).push([i, sim]);
    }
    const nbIdx = new Int32Array(n * k).fill(-1);
    const nbSim = new Float32Array(n * k);
    const counts = new Int32Array(n);
    for (const [i, list] of byItem) {
        list.sort((a, b) => b[1] - a[1]);
        const top = list.slice(0, k);
        counts[i] = top.length;
        for (let r = 0; r < top.length; r++) {
            nbIdx[i * k + r] = top[r][0];
            nbSim[i * k + r] = top[r][1];
        }
    }
    return { n, k, nbIdx, nbSim, counts };
}
const MAGIC = 'ICF2'; // v2: writeHeader 统一头; 旧格式文件 magic 不匹配将自动重建
/** 布局: [magic4][n4][k4][counts n×4][nbIdx n×k×4][nbSim n×k×4] */
export function saveItemCF(a, path) {
    writeFileSync(path, Buffer.concat([writeHeader(MAGIC, [a.n, a.k]), typedBuffer(a.counts), typedBuffer(a.nbIdx), typedBuffer(a.nbSim)]));
}
export function loadItemCF(path) {
    if (!existsSync(path))
        return null;
    const buf = readFileSync(path);
    if (buf.length < 12)
        return null;
    const { magic, fields } = readHeader(buf, 2);
    if (magic !== MAGIC)
        return null;
    const [n, k] = fields;
    const countsBytes = n * 4;
    const idxBytes = n * k * 4;
    const simBytes = n * k * 4;
    if (buf.length < 12 + countsBytes + idxBytes + simBytes)
        return null;
    let off = 12;
    const counts = readTyped(buf, Int32Array, off, n);
    off += countsBytes;
    const nbIdx = readTyped(buf, Int32Array, off, n * k);
    off += idxBytes;
    const nbSim = readTyped(buf, Float32Array, off, n * k);
    return { n, k, nbIdx, nbSim, counts };
}
