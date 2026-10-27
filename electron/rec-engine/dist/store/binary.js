/**
 * 类型化数组二进制存取。
 * 关键点: readFileSync 的 Buffer 可能带非零 byteOffset(共享内存池),
 * 直接 buf.buffer.slice(off) 会相对底层 ArrayBuffer 错位 —— 必须基于 buf 本身拷贝。
 */
export function writeHeader(magic, fields) {
    const m = Buffer.from(magic, 'ascii');
    const f = Buffer.alloc(fields.length * 4);
    fields.forEach((v, i) => f.writeUInt32LE(v, i * 4));
    return Buffer.concat([m, f]);
}
export function readHeader(buf, fieldCount) {
    return {
        magic: buf.subarray(0, 4).toString('ascii'),
        fields: Array.from({ length: fieldCount }, (_, i) => buf.readUInt32LE(4 + i * 4)),
    };
}
/** 从 Buffer 偏移处读取 count 个元素, 返回全新对齐的类型化数组 */
export function readTyped(buf, Ctor, off, count) {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    const copy = new Uint8Array(bytes);
    copy.set(buf.subarray(off, off + bytes));
    return new Ctor(copy.buffer);
}
/** 追加类型化数组到缓冲序列(数据本体, 不带头部) */
export function typedBuffer(arr) {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
