import { z } from 'zod';

const attemptSchema = z.object({
  request: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  setupId: z.string().uuid().nullable(),
  network: z.enum(['testnet', 'mainnet']).nullable(),
  confirmationPending: z.boolean(),
}).strict();
const journalSchema = z.array(attemptSchema).max(100).refine(items => new Set(items.map(item => item.request)).size === items.length);
export type LiveSetupAttempt = z.infer<typeof attemptSchema>;

/** Only opaque request/setup identifiers and network metadata survive reload.
 * No terms, signing material or credentials belong in this journal. */
export function createLiveSetupJournal(scope: string, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const storageKey = `copy-live-setup-recovery:v1:${encodeURIComponent(scope)}`;
  function guarded<T>(work: () => T): T {
    try { return work(); } catch { throw new Error('setup_recovery_unavailable'); }
  }
  const read = () => guarded(() => {
    const raw = storage.getItem(storageKey);
    if (raw && raw.length > 65536) throw new Error('too_large');
    return raw ? journalSchema.parse(JSON.parse(raw)) : [];
  });
  const write = (items: LiveSetupAttempt[]) => guarded(() => {
    const raw = JSON.stringify(journalSchema.parse(items));
    storage.setItem(storageKey, raw);
    if (storage.getItem(storageKey) !== raw) throw new Error('not_saved');
  });
  return {
    find: (request: string) => read().find(item => item.request === request),
    save: (attempt: LiveSetupAttempt) => {
      const parsed = attemptSchema.parse(attempt), items = read();
      const prior = items.find(item => item.request === parsed.request);
      if (prior && (prior.key !== parsed.key || prior.setupId && parsed.setupId && prior.setupId !== parsed.setupId || prior.network && parsed.network && prior.network !== parsed.network)) throw new Error('setup_identity_mismatch');
      write([...items.filter(item => item.request !== parsed.request), parsed]);
    },
    forget: (request: string) => write(read().filter(item => item.request !== request)),
  };
}

export async function setupRequestDigest(name: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
