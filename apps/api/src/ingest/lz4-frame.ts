/**
 * Streaming LZ4 *frame* decoder (the `.lz4` files the `lz4` CLI writes; the
 * archive's hourly objects). Pure JavaScript, so the worker needs no native
 * module. Spec: https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md
 *
 * Verified here: the header checksum's presence, block bounds, and — when the
 * frame carries one — the xxHash32 content checksum of everything decoded,
 * so a truncated or corrupted download fails instead of yielding fills.
 * Block checksums are read and skipped (the content checksum covers them).
 */

const FRAME_MAGIC = 0x184d2204;
const SKIPPABLE_MAGIC = 0x184d2a50;
const DICTIONARY = 65_536;
const BLOCK_MAX: Record<number, number> = { 4: 65_536, 5: 262_144, 6: 1_048_576, 7: 4_194_304 };

export class Lz4FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Lz4FormatError";
  }
}

/** Pulls exact byte counts out of an async chunk stream. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunks: Buffer[] = [];
  private available = 0;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** `length` bytes; null at a clean end of stream (no bytes left). */
  async read(length: number): Promise<Buffer | null> {
    while (this.available < length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else if (next.value.length > 0) {
        this.chunks.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.length));
        this.available += next.value.length;
      }
    }
    if (this.available === 0 && length > 0) return null;
    if (this.available < length) throw new Lz4FormatError("Unexpected end of LZ4 stream");
    const out = this.chunks.length === 1 && this.chunks[0].length === length ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = out.length > length ? [out.subarray(length)] : [];
    this.available -= length;
    return out.subarray(0, length);
  }

  async need(length: number): Promise<Buffer> {
    const bytes = await this.read(length);
    if (!bytes) throw new Lz4FormatError("Unexpected end of LZ4 stream");
    return bytes;
  }
}

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;
const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));

/** Incremental xxHash32 (seed 0), as LZ4 frames use for content checksums. */
export class XxHash32 {
  private v1 = (P1 + P2) | 0;
  private v2 = P2 | 0;
  private v3 = 0;
  private v4 = -P1 | 0;
  private total = 0;
  private readonly pending = Buffer.alloc(16);
  private pendingLength = 0;

  update(data: Buffer): this {
    let offset = 0;
    this.total += data.length;
    if (this.pendingLength > 0) {
      const take = Math.min(16 - this.pendingLength, data.length);
      data.copy(this.pending, this.pendingLength, 0, take);
      this.pendingLength += take;
      offset = take;
      if (this.pendingLength < 16) return this;
      this.stripe(this.pending, 0);
      this.pendingLength = 0;
    }
    for (; offset + 16 <= data.length; offset += 16) this.stripe(data, offset);
    if (offset < data.length) {
      data.copy(this.pending, 0, offset);
      this.pendingLength = data.length - offset;
    }
    return this;
  }

  private stripe(data: Buffer, offset: number): void {
    this.v1 = Math.imul(rotl((this.v1 + Math.imul(data.readUInt32LE(offset), P2)) | 0, 13), P1);
    this.v2 = Math.imul(rotl((this.v2 + Math.imul(data.readUInt32LE(offset + 4), P2)) | 0, 13), P1);
    this.v3 = Math.imul(rotl((this.v3 + Math.imul(data.readUInt32LE(offset + 8), P2)) | 0, 13), P1);
    this.v4 = Math.imul(rotl((this.v4 + Math.imul(data.readUInt32LE(offset + 12), P2)) | 0, 13), P1);
  }

  digest(): number {
    let hash = this.total >= 16
      ? (rotl(this.v1, 1) + rotl(this.v2, 7) + rotl(this.v3, 12) + rotl(this.v4, 18)) | 0
      : (P5 | 0);
    hash = (hash + this.total) | 0;
    let offset = 0;
    for (; offset + 4 <= this.pendingLength; offset += 4) {
      hash = Math.imul(rotl((hash + Math.imul(this.pending.readUInt32LE(offset), P3)) | 0, 17), P4);
    }
    for (; offset < this.pendingLength; offset += 1) {
      hash = Math.imul(rotl((hash + Math.imul(this.pending[offset], P5)) | 0, 11), P1);
    }
    hash = Math.imul(hash ^ (hash >>> 15), P2);
    hash = Math.imul(hash ^ (hash >>> 13), P3);
    return (hash ^ (hash >>> 16)) >>> 0;
  }
}

/** Decodes one LZ4 block into `out` starting at `start` (bytes before it
 * are the dictionary matches may reach into); returns the end offset. */
function decodeBlock(source: Buffer, out: Buffer, start: number): number {
  const length = source.length;
  let s = 0;
  let d = start;
  while (s < length) {
    const token = source[s++];
    let literals = token >> 4;
    if (literals === 15) {
      let byte: number;
      do {
        if (s >= length) throw new Lz4FormatError("Truncated literal length");
        byte = source[s++];
        literals += byte;
      } while (byte === 255);
    }
    if (literals > 0) {
      if (s + literals > length || d + literals > out.length) throw new Lz4FormatError("Literal run exceeds block");
      source.copy(out, d, s, s + literals);
      s += literals;
      d += literals;
    }
    // The last sequence of a block is literals only.
    if (s >= length) break;
    if (s + 2 > length) throw new Lz4FormatError("Truncated match offset");
    const offset = source[s] | (source[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Lz4FormatError("Match offset outside window");
    let match = token & 15;
    if (match === 15) {
      let byte: number;
      do {
        if (s >= length) throw new Lz4FormatError("Truncated match length");
        byte = source[s++];
        match += byte;
      } while (byte === 255);
    }
    match += 4;
    if (d + match > out.length) throw new Lz4FormatError("Match exceeds block size");
    let from = d - offset;
    if (offset >= match) {
      out.copy(out, d, from, from + match);
      d += match;
    } else {
      // Overlapping copy repeats the pattern byte by byte.
      for (let i = 0; i < match; i++) out[d++] = out[from++];
    }
  }
  return d;
}

/**
 * Decompressed chunks of every frame in `source` (concatenated frames and
 * skippable frames are accepted, as `lz4 -d` does).
 * @throws Lz4FormatError on a malformed, truncated or checksum-failing stream.
 */
export async function* decodeLz4Frames(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source);
  let frames = 0;
  for (;;) {
    const magicBytes = await reader.read(4);
    if (!magicBytes) {
      if (frames === 0) throw new Lz4FormatError("Empty LZ4 stream");
      return;
    }
    const magic = magicBytes.readUInt32LE(0);
    if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE_MAGIC) {
      await reader.need((await reader.need(4)).readUInt32LE(0));
      continue;
    }
    if (magic !== FRAME_MAGIC) throw new Lz4FormatError("Not an LZ4 frame");
    frames += 1;
    const [flags, descriptor] = await reader.need(2);
    if (flags >> 6 !== 1) throw new Lz4FormatError("Unsupported LZ4 frame version");
    const independent = (flags & 0x20) !== 0;
    const blockChecksum = (flags & 0x10) !== 0;
    const contentChecksum = (flags & 0x04) !== 0;
    const blockMax = BLOCK_MAX[(descriptor >> 4) & 7];
    if (!blockMax) throw new Lz4FormatError("Unsupported LZ4 block size");
    // Optional content size (8) and dictionary id (4), then the header checksum byte.
    await reader.need(((flags & 0x08) !== 0 ? 8 : 0) + ((flags & 0x01) !== 0 ? 4 : 0) + 1);
    if ((flags & 0x01) !== 0) throw new Lz4FormatError("LZ4 dictionaries are not supported");

    const hash = contentChecksum ? new XxHash32() : null;
    let dictionary: Buffer = Buffer.alloc(0);
    for (;;) {
      const header = (await reader.need(4)).readUInt32LE(0);
      if (header === 0) break;
      const size = header & 0x7fffffff;
      if (size > blockMax) throw new Lz4FormatError("LZ4 block larger than the frame allows");
      const data = await reader.need(size);
      if (blockChecksum) await reader.need(4);
      let chunk: Buffer;
      if ((header & 0x80000000) !== 0) {
        chunk = Buffer.from(data);
      } else {
        const out = Buffer.allocUnsafe(dictionary.length + blockMax);
        dictionary.copy(out, 0);
        chunk = out.subarray(dictionary.length, decodeBlock(data, out, dictionary.length));
      }
      hash?.update(chunk);
      if (!independent) {
        dictionary = chunk.length >= DICTIONARY
          ? chunk.subarray(chunk.length - DICTIONARY)
          : Buffer.concat([dictionary, chunk]).subarray(-DICTIONARY);
      }
      yield chunk;
    }
    if (hash) {
      const expected = (await reader.need(4)).readUInt32LE(0);
      if (hash.digest() !== expected) throw new Lz4FormatError("LZ4 content checksum mismatch");
    }
  }
}

/** Splits decoded chunks into lines (LF), without the terminator; a final
 * unterminated line is yielded too. */
export async function* splitLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    let start = 0;
    for (let end = chunk.indexOf(0x0a, start); end !== -1; end = chunk.indexOf(0x0a, start)) {
      const line = rest.length > 0 ? Buffer.concat([rest, chunk.subarray(start, end)]) : chunk.subarray(start, end);
      rest = Buffer.alloc(0);
      start = end + 1;
      if (line.length > 0) yield line.toString("utf8");
    }
    if (start < chunk.length) rest = Buffer.concat([rest, chunk.subarray(start)]);
  }
  if (rest.length > 0) yield rest.toString("utf8");
}
