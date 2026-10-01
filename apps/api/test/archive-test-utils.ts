/** A frame of stored (uncompressed) blocks: valid LZ4, no compressor needed. */
export function storedFrame(text: string): Buffer {
  const data = Buffer.from(text);
  const parts = [Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82])];
  for (let i = 0; i < data.length; i += 65_536) {
    const block = data.subarray(i, i + 65_536);
    const header = Buffer.alloc(4);
    header.writeUInt32LE((block.length | 0x80000000) >>> 0);
    parts.push(header, block);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

