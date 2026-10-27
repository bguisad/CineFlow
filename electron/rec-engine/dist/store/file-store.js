/**
 * 文件存储层: JSONL 事件日志 + JSON 物料库 —— 零原生依赖,
 * 可直接放进 Electron userData 目录。规模(万级用户/十万级事件)下全量驻内存。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class FileStore {
    dataDir;
    eventsPath;
    itemsPath;
    onboardingPath;
    constructor(dataDir) {
        this.dataDir = dataDir;
        mkdirSync(dataDir, { recursive: true });
        this.eventsPath = join(dataDir, 'events.jsonl');
        this.itemsPath = join(dataDir, 'items.json');
        this.onboardingPath = join(dataDir, 'onboarding.json');
    }
    /** 全量加载事件(十万级 <100MB 内存, 换来 O(1) 在线读取) */
    loadEvents() {
        if (!existsSync(this.eventsPath))
            return [];
        const text = readFileSync(this.eventsPath, 'utf8');
        const events = [];
        for (const line of text.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            try {
                events.push(JSON.parse(s));
            }
            catch {
                // 跳过半截写入的脏行(JSONL 追加天然容错)
            }
        }
        return events;
    }
    appendEvents(events) {
        if (events.length === 0)
            return;
        const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(this.eventsPath, lines, 'utf8');
    }
    loadItems() {
        if (!existsSync(this.itemsPath))
            return [];
        const raw = JSON.parse(readFileSync(this.itemsPath, 'utf8'));
        return raw.items ?? [];
    }
    saveItems(items) {
        writeFileSync(this.itemsPath, JSON.stringify({ items }, null, 0), 'utf8');
    }
    loadOnboarding() {
        if (!existsSync(this.onboardingPath))
            return new Map();
        const raw = JSON.parse(readFileSync(this.onboardingPath, 'utf8'));
        return new Map(Object.entries(raw));
    }
    saveOnboarding(map) {
        writeFileSync(this.onboardingPath, JSON.stringify(Object.fromEntries(map)), 'utf8');
    }
    /** 工件目录(离线预计算结果) */
    artifactPath(name) {
        return join(this.dataDir, 'artifacts', name);
    }
    ensureArtifactDir() {
        const dir = join(this.dataDir, 'artifacts');
        mkdirSync(dir, { recursive: true });
        return dir;
    }
}
