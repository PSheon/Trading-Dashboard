import type { Pool, PoolClient } from 'pg';
import { acquireSettlementConnection, type SettlementClaim } from './copy-live-settlement-claim.js';

/** Uses actual pg clients/SQL, with an additional restrictive scheduling fence.
 * Rollback and destruction remain possible after loss. No authority is issued. */
export function settlementFencedPool(pool: Pool, claim: SettlementClaim): Pool {
  const connect = async (): Promise<PoolClient> => {
    claim.assertFresh();
    const client = await acquireSettlementConnection(pool, claim.signal);
    try { claim.assertFresh(); } catch (error) { client.release(); throw error; }
    let released = false;
    const release = (discard?: boolean | Error) => {
      if (released) return; released = true;
      client.release(claim.signal.aborted || discard);
    };
    const query = async (...args: unknown[]) => {
      const input = args[0];
      const text = typeof input === 'string' ? input : (input as { text?: string })?.text;
      const rollback = /^\s*rollback\s*;?\s*$/i.test(text ?? '');
      try {
        if (!rollback) claim.assertFresh();
        const result: unknown = await Reflect.apply(client.query, client, args);
        if (!rollback) claim.assertFresh();
        return result;
      } catch (error) {
        // Drizzle executes BEGIN before entering its transaction try/finally.
        if (/^\s*begin\b/i.test(text ?? '')) release(true);
        throw error;
      }
    };
    return new Proxy(client, { get(target, property) {
      if (property === 'query') return query;
      if (property === 'release') return release;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') return connect;
    if (property === 'query') return async (...args: unknown[]) => {
      const client = await connect();
      try { return await Reflect.apply(client.query, client, args); }
      finally { client.release(); }
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
