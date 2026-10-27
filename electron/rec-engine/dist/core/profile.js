/** 单条事件 → 行为权重(rate 按分值缩放, dislike 为负) */
export function eventWeight(e, cfg) {
    if (e.type === 'rate') {
        const v = Math.max(1, Math.min(10, e.value ?? 5));
        return Math.min(cfg.eventWeights.rate.max, v * cfg.eventWeights.rate.scale);
    }
    const w = cfg.eventWeights[e.type];
    return typeof w === 'number' ? w : 0;
}
/**
 * 指数时间衰减, halfLife 为半衰期天数。
 * 下限 0.1: 老历史仍保留 10% 权重(长期画像不因下溢而消失), 排序关系不受影响。
 */
const DECAY_FLOOR = 0.1;
export function recencyDecay(ts, now, halfLifeDays) {
    const days = Math.max(0, (now - ts) / 86_400_000);
    return Math.max(Math.pow(0.5, days / halfLifeDays), DECAY_FLOOR);
}
export function emptyProfile(userId) {
    return {
        userId,
        itemWeights: new Map(),
        itemLastTs: new Map(),
        genreWeights: new Map(),
        interactionCount: 0,
        disliked: new Set(),
    };
}
/**
 * 从事件流构建用户画像:
 * - itemWeights 聚合同片多次行为(取强行为), 乘时间衰减在召回时计算
 * - genreWeights 由条目类型聚合, 供标签路使用
 */
export function buildProfile(userId, events, genreOf, now, cfg) {
    const p = emptyProfile(userId);
    for (const e of events) {
        if (e.userId !== userId)
            continue;
        const w = eventWeight(e, cfg);
        if (e.type === 'dislike') {
            p.disliked.add(e.itemId);
            continue;
        }
        if (e.type === 'imp')
            continue; // 曝光不进入兴趣画像
        const prev = p.itemWeights.get(e.itemId) ?? 0;
        // 同片多行为取更强者(避免刷曝光抬高), 时间衰减在召回时施加
        p.itemWeights.set(e.itemId, Math.max(prev, w));
        const last = p.itemLastTs.get(e.itemId) ?? 0;
        p.itemLastTs.set(e.itemId, Math.max(last, e.ts ?? now));
        p.interactionCount += 1;
    }
    for (const [itemId, w] of p.itemWeights) {
        for (const g of genreOf(itemId)) {
            p.genreWeights.set(g, (p.genreWeights.get(g) ?? 0) + w);
        }
    }
    return p;
}
/** 取会话窗口内的交互(按时间倒序), 供实时路使用 */
export function sessionItems(events, userId, now, windowMin) {
    const cutoff = now - windowMin * 60_000;
    const out = [];
    for (let i = events.length - 1; i >= 0 && events[i].ts >= cutoff; i--) {
        const e = events[i];
        if (e.userId === userId && e.type !== 'imp')
            out.push({ itemId: e.itemId, ts: e.ts, type: e.type });
    }
    return out;
}
