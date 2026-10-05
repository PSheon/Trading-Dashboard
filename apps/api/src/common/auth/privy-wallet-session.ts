import { UnauthorizedException } from '@nestjs/common';
import type { RequestUser } from './current-user.js';

/** The browser's Privy identity token, sent next to the access token on the
 * requests that let the server act on the user's wallets. */
export const PRIVY_IDENTITY_TOKEN_HEADER = 'x-privy-identity-token';

function claims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  } catch { return null; }
}

/** Which Privy token a JWT is, for logs only (never verified here): identity
 * tokens carry the user's linked accounts, access tokens a session id. */
export function privyJwtKind(jwt: string): 'identity' | 'access' | 'unknown' {
  const payload = claims(jwt);
  return !payload ? 'unknown' : 'linked_accounts' in payload ? 'identity' : 'sid' in payload ? 'access' : 'unknown';
}

/**
 * The user JWT for Privy's wallet session exchange (`/v1/wallets/authenticate`,
 * `authorization_context.user_jwts`). Privy refuses the access token there
 * ("Invalid JWT token provided", seen on Stage 2026-10-05) and takes the
 * identity token, so the identity token is used when the browser sent one
 * for this same, still-valid user. Its signature is Privy's to check in the
 * exchange; this only keeps a token of another user or an expired one from
 * replacing the access token, which the request was authenticated with.
 * Without a usable identity token the access token is passed as before.
 */
export function privyWalletJwt(user: RequestUser | null, authorization?: string, identityToken?: string, now = Date.now()): string {
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) throw new UnauthorizedException('Sign in required');
  const access = authorization.slice(7).trim(), identity = identityToken?.trim();
  if (!identity || identity.length > 32768 || user?.kind !== 'user') return access;
  const payload = claims(identity);
  if (!payload || payload.sub !== user.privyUserId || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return access;
  return identity;
}
