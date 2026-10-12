import { createHash } from 'node:crypto';

/** Content digests (architecture review E3 #2): not secrets, not signatures.
 * A digest already stored in the database moves here only once its rows are
 * shown byte-identical. */
export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
/** sha256 hex of `JSON.stringify(value)`: key order is the caller's, as before. */
export const jsonDigest = (value: unknown): string => sha256Hex(JSON.stringify(value));
