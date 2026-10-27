export function rrfFuse(candidates, weights, k) {
    const byId = new Map();
    const bySource = new Map();
    for (const c of candidates) {
        let list = bySource.get(c.source);
        if (!list) {
            list = [];
            bySource.set(c.source, list);
        }
        list.push(c);
    }
    for (const [source, list] of bySource) {
        const w = weights[source];
        if (!w || w <= 0)
            continue;
        list.sort((a, b) => b.score - a.score);
        list.forEach((c, rank) => {
            const gain = w / (k + rank + 1);
            let item = byId.get(c.itemId);
            if (!item) {
                item = { itemId: c.itemId, score: 0, norm: 0, reasons: [] };
                byId.set(c.itemId, item);
            }
            item.score += gain;
            if (!item.reasons.includes(source))
                item.reasons.push(source);
        });
    }
    const out = [...byId.values()];
    out.sort((a, b) => b.score - a.score);
    let max = out.length > 0 ? out[0].score : 1;
    if (max <= 0)
        max = 1;
    for (const item of out)
        item.norm = item.score / max;
    return out;
}
