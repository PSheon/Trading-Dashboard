import { BadRequestException, Injectable } from '@nestjs/common';
import { ReferralRepository } from './referral.repository.js';

const CODE = /^[A-Z0-9]{3,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED = new Set(['ADMIN', 'SUPPORT', 'ORBIE', 'API', 'REFERRAL', 'SETTINGS', 'HELP']);
function owner(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequestException('Invalid referral owner'); return value; }
function code(value: string): string {
  if (typeof value !== 'string' || !CODE.test(value.trim().toUpperCase())) throw new BadRequestException({ code: 'referral_code_invalid', message: 'Use 3–16 letters or numbers' });
  return value.trim().toUpperCase();
}
function uuid(value: string): string { if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException('Invalid referral operation identity'); return value.toLowerCase(); }
export interface ReferralPage { cursor?: string; limit?: number }
export interface ReferralCursor { at: Date; id: string }
export function referralCursor(at: Date, id: string): string { return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url'); }
function page(input: ReferralPage): { cursor: ReferralCursor | null; limit: number } {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Invalid referral page size');
  if (input.cursor === undefined) return { cursor: null, limit };
  try {
    if (typeof input.cursor !== 'string' || input.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string') throw new Error();
    const at = new Date(parsed[0]);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== parsed[0]) throw new Error();
    return { cursor: { at, id: uuid(parsed[1]) }, limit };
  } catch { throw new BadRequestException('Invalid referral cursor'); }
}

@Injectable()
export class ReferralService {
  constructor(private readonly repository: ReferralRepository) {}
  async me(userId: number) {
    const result = await this.repository.overview(owner(userId));
    return { ...result, link: `/r/${result.code}`, canClaim: false,
      claimCapability: { enabled: false as const, reason: 'collection_and_payout_unavailable' as const } };
  }
  async check(raw: string) { const normalized = code(raw); return { code: normalized, valid: !RESERVED.has(normalized) && await this.repository.check(normalized) }; }
  async setCode(userId: number, raw: string) {
    const normalized = code(raw);
    if (RESERVED.has(normalized)) throw new BadRequestException({ code: 'referral_code_reserved', message: 'This code is reserved' });
    return this.repository.setCode(owner(userId), normalized);
  }
  async bind(userId: number, raw: string) { return this.repository.bind(owner(userId), code(raw)); }
  async friends(userId: number, query: ReferralPage = {}) { return this.repository.friends(owner(userId), page(query)); }
  async claims(userId: number, query: ReferralPage = {}) { return this.repository.claims(owner(userId), page(query)); }
  async getClaim(userId: number, claimId: string) { return this.repository.findClaim(owner(userId), uuid(claimId)); }
  async getClaimByKey(userId: number, key: string) { return this.repository.findClaimByKey(owner(userId), uuid(key)); }
  async claim(userId: number, idempotencyKey: string) {
    // Existing requests are resolved by the DAL before capability checks. The
    // unavailable payout integration must never hide an uncertain old claim.
    return this.repository.claim(owner(userId), uuid(idempotencyKey));
  }
}
