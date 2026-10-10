import { z } from 'zod';

const code = z.string().regex(/^[A-Z0-9]{3,16}$/);
// Integer USDC micro-units (six decimals), never a floating-point dollar value.
const units = z.string().regex(/^(0|[1-9][0-9]{0,38})$/).refine(v => BigInt(v) <= (1n << 128n) - 1n);
const timestamp = z.string().datetime();
const cursor = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).nullable();
export const referralCodeSchema = z.object({ code }).strict();
export const referralCheckSchema = z.object({ code, valid: z.boolean() }).strict();
export const referralBindSchema = z.object({ bound: z.literal(true), boundAt: timestamp }).strict();
export const referralOverviewSchema = z.object({
  code, link: z.string().regex(/^\/r\/[A-Z0-9]{3,16}$/), referred: z.boolean(), bindOpenUntil: timestamp.nullable(), hasWallet: z.boolean(),
  policy: z.object({ version: z.string().min(1).max(100), enabled: z.boolean(), rewardBps: z.number().int().min(0).max(10000).nullable(),
    minClaimUnits: units.refine(v => BigInt(v) > 0n).nullable(), bindWindowSeconds: z.number().int().min(1).max(2592000) }).strict(),
  balances: z.object({ earned: units, available: units, pending: units, claimed: units }).strict(),
  canClaim: z.literal(false), claimCapability: z.object({ enabled: z.literal(false), reason: z.literal('collection_and_payout_unavailable') }).strict(),
}).strict().superRefine((v, ctx) => {
  if (v.link !== `/r/${v.code}` || v.referred && v.bindOpenUntil !== null || BigInt(v.balances.earned) !== BigInt(v.balances.available) + BigInt(v.balances.pending) + BigInt(v.balances.claimed))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid referral ownership or balances' });
});
export const referralFriendsSchema = z.object({ invited: z.number().int().nonnegative(), copying: z.number().int().nonnegative(), items: z.array(z.object({
  id: z.string().uuid(), label: z.string().min(1).max(100), joinedAt: timestamp, copying: z.boolean(), copyingModes: z.array(z.enum(['paper', 'testnet', 'mainnet'])).max(3),
}).strict()).max(100), nextCursor: cursor }).strict().refine(v => v.copying <= v.invited);
export const referralClaimSchema = z.object({ id: z.string().uuid(), idempotencyKey: z.string().uuid(), amountUnits: units.refine(v => BigInt(v) > 0n),
  destination: z.string().regex(/^0x[0-9a-f]{40}$/).refine(v => v !== `0x${'0'.repeat(40)}`), network: z.literal('mainnet'), token: z.literal('USDC'),
  status: z.enum(['requested', 'approved', 'sending', 'unknown', 'paid', 'rejected', 'failed']), policyVersion: z.string().min(1).max(100),
  createdAt: timestamp, updatedAt: timestamp }).strict().refine(v => Date.parse(v.updatedAt) >= Date.parse(v.createdAt));
export const referralClaimsSchema = z.object({ items: z.array(referralClaimSchema).max(100), nextCursor: cursor }).strict();
export type ReferralOverview = z.infer<typeof referralOverviewSchema>;
export type ReferralFriends = z.infer<typeof referralFriendsSchema>;
export type ReferralClaim = z.infer<typeof referralClaimSchema>;
export type ReferralClaims = z.infer<typeof referralClaimsSchema>;
