import { createHash } from 'node:crypto';

/** Content digests (review E3 #2): not secrets, not signatures. A stored digest moves here
 * only once shown byte-identical. */
export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
/** sha256 hex of `JSON.stringify(value)`: key order is the caller's. */
export const jsonDigest = (value: unknown): string => sha256Hex(JSON.stringify(value));
