/**
 * 轻量分词: 中文按二元 bigram, 拉丁文按小写词切分 ——
 * 对影视标题/标签/简介这种短文本, bigram 是性价比最高的语义表示。
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
export function tokenize(text) {
    const tokens = [];
    for (const chunk of text.toLowerCase().split(SPLIT_RE)) {
        if (!chunk)
            continue;
        if (CJK_RE.test(chunk)) {
            // 中文段: bigram(单字保留)
            for (let i = 0; i < chunk.length; i++) {
                if (chunk.length === 1) {
                    tokens.push(chunk[i]);
                }
                else if (i < chunk.length - 1) {
                    tokens.push(chunk.slice(i, i + 2));
                }
            }
        }
        else if (chunk.length > 1) {
            tokens.push(chunk);
        }
    }
    return tokens;
}
/** 物料文本组装: 类型×3 + 标签×2 + 演员×2 + 标题 + 简介(权重靠重复次数) */
export function itemText(item) {
    const parts = [];
    parts.push(...item.genres, ...item.genres, ...item.genres);
    if (item.tags?.length)
        parts.push(...item.tags, ...item.tags);
    if (item.actors?.length)
        parts.push(...item.actors, ...item.actors);
    parts.push(item.title);
    if (item.overview)
        parts.push(item.overview);
    return parts.join(' ');
}
