import { z } from 'zod';
import { liveCopySetupAbortSchema, requestLiveCopySetupAbortSchema, type LiveCopySetupAbort } from '@trading-dashboard/shared/contracts';

const selectionSchema = z.object({ id: z.string().uuid(), kind: z.enum(['start', 'edit', 'renewal']),
  strategyId: z.number().int().positive(), accountId: z.string().min(1).max(128).nullable() }).strict();
export type SetupAbortSelection = z.infer<typeof selectionSchema>;
const attemptSchema = z.object({ setup: selectionSchema, network: z.enum(['testnet', 'mainnet']), request: requestLiveCopySetupAbortSchema }).strict();
const attemptsSchema = z.array(attemptSchema).max(100).refine(items => new Set(items.map(item => item.setup.id)).size === items.length &&
  new Set(items.map(item => item.request.idempotencyKey)).size === items.length);
export function createSetupAbortJournal(owner: string, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `copy-setup-aborts:v1:${encodeURIComponent(owner)}`;
  const read = () => {
    const raw = storage.getItem(key);
    if (raw && raw.length > 65536) throw new Error('setup_abort_storage');
    return raw ? attemptsSchema.parse(JSON.parse(raw)) : [];
  };
  return { read, save(input: z.input<typeof attemptSchema>) {
    const attempt = attemptSchema.parse(input), items = read();
    const previous = items.find(item => item.setup.id === attempt.setup.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) throw new Error('setup_abort_binding_changed');
    const raw = JSON.stringify(attemptsSchema.parse(previous ? items : [...items, attempt]));
    if (raw.length > 65536) throw new Error('setup_abort_storage');
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error('setup_abort_storage');
  } };
}
export interface SetupAbortOwner {
  status: string; mode: string; identity: string | null; userId: string | null; session: string; siteMode: string;
  network: 'testnet' | 'mainnet' | null; available: boolean;
}
export interface SetupAbortDeps {
  snapshot(): SetupAbortOwner; current(): SetupAbortSelection | null;
  journal: ReturnType<typeof createSetupAbortJournal>; newKey(): string;
  get(setupId: string): Promise<unknown>;
  post(setupId: string, request: { idempotencyKey: string }, beforeSend: () => void): Promise<unknown>;
}
export function setupAbortFence(snapshot: () => SetupAbortOwner) {
  const owner = { ...snapshot() };
  if (owner.status !== 'signedIn' || owner.mode !== 'privy' || !owner.userId || !owner.identity || !owner.available ||
    !owner.network || owner.siteMode !== (owner.network === 'testnet' ? 'testnet' : 'live')) throw new Error('setup_abort_unavailable');
  return () => { if (JSON.stringify(owner) !== JSON.stringify(snapshot())) throw new Error('setup_abort_owner_changed'); };
}
export function validateSetupAbortProgress(raw: unknown, setup: SetupAbortSelection, network: SetupAbortOwner['network']): LiveCopySetupAbort {
  const progress = liveCopySetupAbortSchema.parse(raw);
  if (progress.setupId !== setup.id || progress.kind !== setup.kind || progress.strategyId !== setup.strategyId || progress.network !== network ||
    setup.accountId !== null && progress.accountId !== setup.accountId) throw new Error('setup_abort_progress_changed');
  return progress;
}
/** This POST creates an idempotent local barrier, not a transfer. After an
 * uncertain response, an explicit retry reads first and may request ONLY the
 * same saved key and setup. The server reuses its one durable abort authority. */
export async function requestSetupAbort(input: SetupAbortSelection, deps: SetupAbortDeps): Promise<LiveCopySetupAbort> {
  const setup = selectionSchema.parse(input), owner = setupAbortFence(deps.snapshot), network = deps.snapshot().network;
  const guard = () => {
    owner();
    const current = deps.current();
    if (!current || JSON.stringify(selectionSchema.parse(current)) !== JSON.stringify(setup)) throw new Error('setup_abort_binding_changed');
  };
  guard();
  try {
    const saved = await deps.get(setup.id); guard();
    return validateSetupAbortProgress(saved, setup, network);
  } catch (error) {
    guard();
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404) throw error;
  }
  const previous = deps.journal.read().find(item => item.setup.id === setup.id);
  if (previous && (previous.network !== network || previous.setup.kind !== setup.kind || previous.setup.strategyId !== setup.strategyId ||
    previous.setup.accountId !== null && previous.setup.accountId !== setup.accountId)) throw new Error('setup_abort_binding_changed');
  const attempt = previous ?? attemptSchema.parse({ setup, network, request: { idempotencyKey: deps.newKey() } });
  deps.journal.save(attempt); guard();
  const result = await deps.post(setup.id, attempt.request, guard); guard();
  return validateSetupAbortProgress(result, setup, network);
}
