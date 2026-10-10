"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  referralOverviewSchema,
  referralFriendsSchema,
  referralClaimsSchema,
  referralClaimSchema,
  referralCodeSchema,
  referralBindSchema,
  type ReferralOverview,
} from "./contracts";
import { api, ApiError, sessionKey } from "./api";
import { useAuth } from "./auth";

export interface ReferralOwner {
  status: string;
  mode: string;
  identity: string | null;
  userId?: string | null;
  session: string;
}
const ROOT = "/me/referral",
  TTL = 30 * 86400000,
  CAPTURE = "orbie.referral.capture.v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface Capture {
  code: string;
  at: number;
  owner: string | null;
  attempted: boolean;
}
function storage() {
  return typeof window === "undefined" ? null : window.localStorage;
}
export function referralOwnerKey(o: Pick<ReferralOwner, "mode" | "identity" | "userId">) {
  return JSON.stringify([o.mode, o.userId ?? o.identity]);
}
const ownerKey = referralOwnerKey;
export function referralCaptureBelongsTo(owner: Pick<ReferralOwner, "mode" | "identity" | "userId">, pinned: string | null) {
  return pinned === null || pinned === ownerKey(owner) || pinned === JSON.stringify([owner.mode, owner.identity]);
}
/** Legacy journals remain readable until their exact original record is resolved.
 * Never overwrite a conflicting intent during identity-key migration. */
function journalKeys(kind: "claim" | "code", owner: ReferralOwner) {
  return [...new Set([ownerKey(owner), JSON.stringify([owner.mode, owner.identity])])]
    .map(key => `orbie.referral.${kind}.v1:${key}`);
}
function readJournal(kind: "claim" | "code", owner: ReferralOwner) {
  const keys = journalKeys(kind, owner);
  const values = keys.map(key => storage()?.getItem(key)).filter((v): v is string => !!v);
  const value = JSON.parse(values[0] ?? "null");
  if (value !== null && eligible(owner) && !storage()?.getItem(keys[0]!)) {
    // Copy metadata only. Recovery still checks the server-side owner; the
    // legacy key remains until the exact original request is resolved.
    write(keys[0]!, value);
  }
  return value;
}
function clearJournal(kind: "claim" | "code", owner: ReferralOwner, resolved: string) {
  for (const key of journalKeys(kind, owner)) {
    if (storage()?.getItem(key) === JSON.stringify(resolved)) storage()?.removeItem(key);
  }
}
function eligible(o: ReferralOwner) {
  return o.status === "signedIn" && o.mode === "privy" && !!o.identity;
}
function write(key: string, value: unknown) {
  const s = storage();
  if (!s) throw new Error("referral_storage_unavailable");
  const text = JSON.stringify(value);
  s.setItem(key, text);
  if (s.getItem(key) !== text) throw new Error("referral_storage_unavailable");
  if (key === CAPTURE)
    window.dispatchEvent(new Event("orbie:referral-capture"));
}
export function pendingReferral(now = Date.now()): Capture | null {
  try {
    const text = storage()?.getItem(CAPTURE);
    if (!text) return null;
    const r = JSON.parse(text) as Capture;
    if (
      !r ||
      !/^[A-Z0-9]{3,16}$/.test(r.code) ||
      !Number.isSafeInteger(r.at) ||
      r.at > now ||
      now - r.at >= TTL ||
      !(r.owner === null || typeof r.owner === "string") ||
      typeof r.attempted !== "boolean"
    ) {
      storage()?.removeItem(CAPTURE);
      return null;
    }
    return r;
  } catch {
    return null;
  }
}
function subscribeCapture(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("orbie:referral-capture", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("orbie:referral-capture", listener);
  };
}
function captureText() {
  try {
    return storage()?.getItem(CAPTURE) ?? null;
  } catch {
    return null;
  }
}
export function useReferralCaptureRecord() {
  useSyncExternalStore(subscribeCapture, captureText, () => null);
  return pendingReferral();
}
/** First-touch capture belongs to the first ready owner for its entire original TTL. */
export function pinReferral(owner: ReferralOwner): Capture | null {
  const capture = pendingReferral();
  if (!capture || !eligible(owner)) return null;
  if (capture.owner !== null && !referralCaptureBelongsTo(owner, capture.owner)) return null;
  if (capture.owner === ownerKey(owner)) return capture;
  const pinned = { ...capture, owner: ownerKey(owner) };
  write(CAPTURE, pinned);
  return pinned;
}
export function captureReferral(raw: string, now = Date.now()) {
  const code = raw.toUpperCase();
  if (!/^[A-Z0-9]{3,16}$/.test(code) || !Number.isSafeInteger(now))
    return false;
  try {
    if (!pendingReferral(now))
      write(CAPTURE, { code, at: now, owner: null, attempted: false });
    return true;
  } catch {
    return false;
  }
}
/** USDC integer micro-units, exactly six decimal places; never floating point. */
export function referralUnits(value: string) {
  if (!/^(0|[1-9][0-9]{0,38})$/.test(value))
    throw new Error("referral_units_invalid");
  const n = BigInt(value),
    scale = BigInt(1000000);
  const fraction = (n % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return `${n / scale}${fraction ? `.${fraction}` : ""}`;
}
export function claimJournal(o: ReferralOwner) {
  const key = `orbie.referral.claim.v1:${ownerKey(o)}`;
  return {
    read(): string | null {
      try {
        const v = readJournal("claim", o);
        return typeof v === "string" && UUID.test(v) ? v : null;
      } catch {
        return null;
      }
    },
    save(id: string) {
      if (!eligible(o) || !UUID.test(id))
        throw new Error("referral_request_invalid");
      const original = this.read();
      if (original && original !== id)
        throw new Error("referral_request_pending");
      write(key, id);
    },
  };
}
export function referralClient(current: () => ReferralOwner) {
  const start = { ...current() };
  const assert = () => {
    if (!eligible(start) || JSON.stringify(current()) !== JSON.stringify(start))
      throw new Error("referral_session_changed");
  };
  return {
    async setCode(raw: string) {
      assert();
      if (journalKeys("code", start).some(key => storage()?.getItem(key) != null)) throw new Error("referral_request_pending");
      const code = referralCodeSchema.parse({ code: raw.toUpperCase() }).code;
      const key = `orbie.referral.code.v1:${ownerKey(start)}`;
      write(key, code);
      try {
        const result = referralCodeSchema.parse(
          await api.post(`${ROOT}/code`, { code }, { beforeSend: assert }),
        );
        assert();
        if (result.code !== code) throw new Error("referral_record_mismatch");
        clearJournal("code", start, code);
        return result;
      } catch (error) {
        assert(); // Only a definitive HTTP refusal releases the original request.
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        )
          clearJournal("code", start, code);
        throw error;
      }
    },
    pendingCode(): string | null {
      try {
        const v = readJournal("code", start);
        return referralCodeSchema.parse({ code: v }).code;
      } catch {
        return null;
      }
    },
    async recoverCode() {
      assert();
      const result = referralOverviewSchema.parse(await api.get(ROOT));
      assert();
      if (result.code === this.pendingCode()) clearJournal("code", start, result.code);
      return result;
    },
    async bind(input: ReferralOverview) {
      assert();
      const overview = referralOverviewSchema.parse(input),
        capture = pinReferral(start);
      if (
        !capture ||
        capture.attempted ||
        !referralCaptureBelongsTo(start, capture.owner) ||
        overview.referred ||
        capture.code === overview.code ||
        !overview.bindOpenUntil ||
        Date.parse(overview.bindOpenUntil) <= Date.now()
      )
        return null;
      const pinned = { ...capture, owner: ownerKey(start), attempted: true };
      write(CAPTURE, pinned);
      const beforeSend = () => {
        assert();
        if (
          Date.parse(overview.bindOpenUntil!) <= Date.now() ||
          JSON.stringify(pendingReferral()) !== JSON.stringify(pinned)
        )
          throw new Error("referral_bind_changed");
      };
      const result = referralBindSchema.parse(
        await api.post(`${ROOT}/bind`, { code: capture.code }, { beforeSend }),
      );
      assert();
      return result; // Retain the consumed owner pin; a later login must never inherit this invitation.
    },
    async createClaim(overview: unknown): Promise<never> {
      void overview;
      assert();
      throw new Error("referral_payout_unavailable");
    },
    async readClaim(input: unknown) {
      assert();
      const original = referralClaimSchema.parse(input);
      const result = referralClaimSchema.parse(
        await api.get(`${ROOT}/claims/${encodeURIComponent(original.id)}`),
      );
      assert();
      if (
        result.id !== original.id ||
        result.idempotencyKey !== original.idempotencyKey ||
        result.destination !== original.destination ||
        result.amountUnits !== original.amountUnits ||
        result.policyVersion !== original.policyVersion ||
        result.createdAt !== original.createdAt
      )
        throw new Error("referral_record_mismatch");
      return result;
    },
    async recoverClaim() {
      assert();
      const key = claimJournal(start).read();
      if (!key) return null;
      const result = referralClaimSchema.parse(
        await api.get(`${ROOT}/claims/by-key/${encodeURIComponent(key)}`),
      );
      assert();
      if (result.idempotencyKey !== key)
        throw new Error("referral_record_mismatch");
      return result;
    },
  };
}
export function useReferralSession() {
  const auth = useAuth(),
    mounted = useRef(false),
    latest = useRef(auth),
    client = useQueryClient();
  useLayoutEffect(() => {
    latest.current = auth;
  }, [auth]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = useCallback(() => {
    const a = latest.current;
    return {
      status: mounted.current ? a.status : "disposed",
      mode: a.mode,
      identity: a.identity,
      userId: a.userId,
      session: sessionKey(),
    };
  }, []);
  const scope = JSON.stringify([
    auth.status,
    auth.mode,
    auth.userId ?? auth.identity,
    sessionKey(),
  ]);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ["referral", scope] });
      client.removeQueries({ queryKey: ["referral", scope] });
    },
    [client, scope],
  );
  return {
    enabled:
      auth.status === "signedIn" && auth.mode === "privy" && !!auth.identity,
    key: ["referral", scope] as const,
    owner,
    client,
  };
}
export function useReferralOverview(needed = true) {
  const s = useReferralSession();
  const q = useQuery({
    queryKey: [...s.key, "overview"],
    enabled: s.enabled && needed,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const result = await referralClient(s.owner).recoverCode();
      return result;
    },
  });
  return {
    ...q,
    data: s.enabled && needed && !q.isError ? q.data : undefined,
    session: s,
  };
}
export function useReferralFriends(cursor: string | null) {
  const s = useReferralSession();
  const q = useQuery({
    queryKey: [...s.key, "friends", cursor],
    enabled: s.enabled,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const start = JSON.stringify(s.owner());
      const result = referralFriendsSchema.parse(
        await api.get(
          `${ROOT}/friends?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
      if (JSON.stringify(s.owner()) !== start)
        throw new Error("referral_session_changed");
      return result;
    },
  });
  return { ...q, data: s.enabled && !q.isError ? q.data : undefined };
}
export function useReferralClaims(cursor: string | null) {
  const s = useReferralSession();
  const q = useQuery({
    queryKey: [...s.key, "claims", cursor],
    enabled: s.enabled,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const start = JSON.stringify(s.owner());
      const result = referralClaimsSchema.parse(
        await api.get(
          `${ROOT}/claims?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
      if (JSON.stringify(s.owner()) !== start)
        throw new Error("referral_session_changed");
      return result;
    },
  });
  return { ...q, data: s.enabled && !q.isError ? q.data : undefined };
}
