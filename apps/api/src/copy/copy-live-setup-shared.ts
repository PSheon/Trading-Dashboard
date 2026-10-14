import { BadRequestException, ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { liveCopySetupIntentSchema, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import type { deploymentNetwork } from './live-deployment.js';
import { AppConfig } from '../config/app-config.js';
import { DEFAULT_LIVE_SETUP_TIMINGS, type LiveSetupTimings } from '../config/live-timings.js';
import { StepFail, StepWait } from './live/error-class.js';
import { CopyLiveSetupRepository, type SetupRow, type SetupStage } from './copy-live-setup.repository.js';
import type { MasterAccount, MasterActionBound, MasterTypedData } from './live/master-action.js';
import { jsonDigest as digest } from '../common/crypto/digest.js';
export { digest };

/** What every part of a live copy setup shares (composed by copy-live-setup.service.ts). */

/** The setup's deposit key, a UUID from the setup id and the deposit it replaces, so every pass and
 * driver reserves the same deposit. Never the revision: a lost CAS would orphan a `prepared` deposit
 * (money audit 2026-10-12). */
export function setupFundingKey(row: Pick<SetupRow, 'id' | 'fundingOperationId'>): string {
  const h = createHash('sha256').update(`live-setup-funding:${row.id}:${row.fundingOperationId ?? ''}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Signs every step after confirm: the worker under the owner's Privy policy, exactly the payload the
 * consent bound (2026-10-07). */
export interface SetupSigner {
  sign(account: MasterAccount, data: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string>;
}
/** A step can't go on yet (a lookup is pending, or a signature is due): a
 * `budget` wait, never an attempt (live/error-class.ts). */
export class Wait extends StepWait { constructor(issue: string, retryMs = DEFAULT_LIVE_SETUP_TIMINGS.retry.pendingMs) { super(issue, retryMs); } }
/** The setup cannot finish; the owner sees the code (`permanent`). */
export class Fail extends StepFail {}
export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid setup request');
  return structuredClone(parsed.data);
}
export const refuse = (status: 409 | 503, code: string, message: string): never => {
  throw status === 409 ? new ConflictException({ statusCode: 409, code, message }) : new ServiceUnavailableException({ statusCode: 503, code, message });
};

type DeploymentNetwork = ReturnType<typeof deploymentNetwork>;
/** What the setup's parts read from the service that composes them. */
export interface SetupContext {
  readonly config: AppConfig;
  readonly repository: CopyLiveSetupRepository;
  readonly now: () => number;
  /** The deployment's network (the service's own getter, so a test's stub reaches every part). */
  readonly network: () => DeploymentNetwork;
  readonly logger: Logger;
}

/** A part of the setup: the context's fields under the names the bodies use, and the row helpers. */
export abstract class SetupPart {
  protected readonly config: AppConfig;
  protected readonly repository: CopyLiveSetupRepository;
  protected readonly now: () => number;
  protected readonly logger: Logger;
  constructor(protected readonly ctx: SetupContext) {
    this.config = ctx.config; this.repository = ctx.repository; this.now = ctx.now; this.logger = ctx.logger;
  }
  protected get network(): DeploymentNetwork { return this.ctx.network(); }
  /** The lease, step budget and retries (AppConfig.copy.live.setup). */
  protected get timings(): LiveSetupTimings { return this.config.value.copy.live?.setup ?? DEFAULT_LIVE_SETUP_TIMINGS; }
  protected async move(row: SetupRow, stage: SetupStage, changes: Partial<SetupRow> = {}): Promise<SetupRow> {
    const next = await this.repository.transition(row, { stage, issue: null, attempts: 0, nextAttemptAt: null, ...changes });
    if (!next) throw new Wait('setup_changed', 0);
    return next;
  }
  protected intent(row: SetupRow): LiveCopySetupIntent {
    const parsed = liveCopySetupIntentSchema.safeParse(row.intent);
    if (!parsed.success || digest(parsed.data) !== row.intentDigest || !row.consentDigest) throw new Fail('setup_binding_changed');
    return parsed.data;
  }
  /** Past the deadline nothing new is signed; a step already in flight is
   * still reconciled, and money already sent is still confirmed. */
  protected assertBeforeDeadline(row: SetupRow) {
    if (row.setupDeadline && this.now() >= row.setupDeadline.getTime()) throw new Fail('setup_expired');
  }
  protected requireSigner(signer: SetupSigner | null): SetupSigner {
    if (!signer) throw new Wait('worker_signer_unavailable', this.timings.retry.signerUnavailableMs);
    return signer;
  }

}
