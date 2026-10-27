function genreSet(item) {
    return new Set(item.genres.length ? item.genres : ['unknown']);
}
function jaccard(a, b) {
    let inter = 0;
    for (const x of a)
        if (b.has(x))
            inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}
function isNewItem(item, now, cfg) {
    if (!item.releaseDate)
        return false;
    const ageDays = (now - Date.parse(item.releaseDate)) / 86_400_000;
    return ageDays >= 0 && ageDays < cfg.newItemAgeDays;
}
/**
 * 对融合后的候选列表做多样性重排, 返回排好序的完整列表(调用方分页)。
 * 同时保证: 同类型最多连续 maxConsecutiveSameGenre 个;
 * 每页(前 size 个)新片(近 newItemAgeDays)数量 ≥ newItemQuotaPerPage(候选足够时)。
 */
export function rerank(fused, itemsById, cfg, now, size) {
    const λ = cfg.mmrLambda;
    const pool = fused.slice(0, Math.max(size * 4, 60)); // 只重排头部, 控制复杂度
    const selected = [];
    const selectedGenres = [];
    const remaining = [...pool];
    const tooManySameGenre = (gs) => {
        if (selected.length === 0)
            return false;
        const tail = selectedGenres.slice(-cfg.maxConsecutiveSameGenre);
        return tail.every((t) => jaccard(t, gs) >= 0.5);
    };
    while (remaining.length > 0) {
        let bestPos = -1;
        let bestVal = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const item = itemsById.get(remaining[i].itemId);
            const gs = item ? genreSet(item) : new Set(['unknown']);
            let div = 1;
            if (selectedGenres.length > 0) {
                let maxJ = 0;
                for (const sg of selectedGenres)
                    maxJ = Math.max(maxJ, jaccard(sg, gs));
                div = 1 - maxJ;
            }
            let val = λ * remaining[i].norm + (1 - λ) * div;
            if (tooManySameGenre(gs))
                val -= 10; // 硬约束: 连续同类型重罚
            if (val > bestVal) {
                bestVal = val;
                bestPos = i;
            }
        }
        const [picked] = remaining.splice(bestPos, 1);
        selected.push(picked);
        const it = itemsById.get(picked.itemId);
        selectedGenres.push(it ? genreSet(it) : new Set(['unknown']));
    }
    // 新片扶持配额: 前 size 里新片不足则从池尾部调换(新片已带 1.2/1.5 权重加成, 这里兜底)
    const newInHead = selected.slice(0, size).filter((f) => {
        const it = itemsById.get(f.itemId);
        return it ? isNewItem(it, now, cfg) : false;
    }).length;
    if (newInHead < cfg.newItemQuotaPerPage) {
        const need = cfg.newItemQuotaPerPage - newInHead;
        const newCandidates = pool.filter((f) => {
            const it = itemsById.get(f.itemId);
            return it && isNewItem(it, now, cfg) && !selected.slice(0, size).includes(f);
        });
        for (let i = 0; i < need && i < newCandidates.length; i++) {
            // 交换到第 3、8 位这类中前排位置
            const pos = Math.min(size - 1, 3 + i * 5);
            const victimPos = selected.findIndex((f, idx) => idx >= pos && !isNew(itemsById.get(f.itemId), now, cfg));
            if (victimPos >= 0) {
                const victim = selected[victimPos];
                selected[victimPos] = newCandidates[i];
                selected[selected.indexOf(newCandidates[i])] = victim;
            }
        }
    }
    return selected;
}
function isNew(item, now, cfg) {
    return item ? isNewItem(item, now, cfg) : false;
}
