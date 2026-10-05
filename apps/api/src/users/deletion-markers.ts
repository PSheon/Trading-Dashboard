import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";

import type { AppConfig } from "../config/app-config.js";
import type { DbExecutor } from "../db/unit-of-work.js";

/**
 * A deleted account's identity, as keyed hashes only (account_deletion_markers,
 * docs/account-deletion.md): HMAC-SHA256 of the Privy id, the email and the
 * wallet addresses, under a key derived from a server secret, kept for
 * RETENTION_ACCOUNT_DELETION_DAYS. Without the key a digest can't be checked
 * against anyone; with it, only an identity that signs up again matches.
 * Used for one thing: a returning identity can't bind a new referral in that
 * window, so deleting and signing up again can't farm invites.
 *
 * The key is derived from PRIVY_APP_SECRET, else AUTH_SERVICE_TOKEN (a strong
 * secret in production); local development without either uses a fixed key.
 * Rotating the secret only makes older markers stop matching (fails open).
 */
export interface DeletedIdentity { privyUserId: string; email: string | null; walletAddress: string | null; embeddedWalletAddress: string | null }

function markerKey(config?: AppConfig): Buffer {
  const secret = config?.value.auth.appSecret ?? config?.value.auth.serviceToken ?? "orbie-local-development-only";
  return createHash("sha256").update(`orbie:account-deletion-marker:v1:${secret}`).digest();
}

/** The digests of every identifier the identity has (deduplicated). */
export function identityDigests(identity: DeletedIdentity, config?: AppConfig): string[] {
  const key = markerKey(config);
  const parts = [`privy:${identity.privyUserId}`,
    identity.email ? `email:${identity.email.trim().toLowerCase()}` : null,
    identity.walletAddress ? `wallet:${identity.walletAddress.toLowerCase()}` : null,
    identity.embeddedWalletAddress ? `wallet:${identity.embeddedWalletAddress.toLowerCase()}` : null];
  return [...new Set(parts.filter((p): p is string => p !== null).map((p) => createHmac("sha256", key).update(p).digest("hex")))];
}

/** Records the identity as deleted now (a later deletion renews the window). */
export async function recordDeletedIdentity(db: DbExecutor, identity: DeletedIdentity, config?: AppConfig): Promise<number> {
  const digests = identityDigests(identity, config);
  for (const digest of digests) {
    await db.execute(sql`insert into account_deletion_markers (digest, deleted_at) values (${digest}, now())
      on conflict (digest) do update set deleted_at = excluded.deleted_at`);
  }
  return digests.length;
}

/** Whether this identity deleted an account within the retention window
 * (the retention job removes markers after it). */
export async function isReturningIdentity(db: DbExecutor, identity: DeletedIdentity, config?: AppConfig): Promise<boolean> {
  const digests = identityDigests(identity, config);
  const { rows } = await db.execute<{ found: boolean }>(sql`select exists (select 1 from account_deletion_markers where digest in ${digests}) as found`);
  return rows[0]?.found === true;
}
