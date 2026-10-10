// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "@/lib/api";
import {
  captureReferral,
  pendingReferral,
  referralUnits,
  referralClient,
  claimJournal,
} from "@/lib/referral";
const now = Date.parse("2026-10-04T00:00:00Z");
const owner = () => ({
  status: "signedIn",
  mode: "privy",
  identity: "alice",
  session: "1",
});
const overview = {
  code: "ALICE",
  link: "/r/ALICE",
  referred: false,
  bindOpenUntil: new Date(now + 10000).toISOString(),
  hasWallet: true,
  policy: {
    version: "unconfirmed",
    enabled: false,
    rewardBps: null,
    minClaimUnits: null,
    bindWindowSeconds: 86400,
  },
  balances: { earned: "0", available: "0", pending: "0", claimed: "0" },
  canClaim: false as const,
  claimCapability: {
    enabled: false as const,
    reason: "collection_and_payout_unavailable" as const,
  },
};
const claim = {
  id: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "20000000-0000-4000-8000-000000000001",
  amountUnits: "1000000",
  destination: `0x${"ab".repeat(20)}`,
  network: "mainnet",
  token: "USDC",
  status: "unknown",
  policyVersion: "old",
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(now);
});
it("captures normalized links once without extending the original 30-day TTL", () => {
  expect(captureReferral("abc", now)).toBe(true);
  captureReferral("XYZ", now + 1000);
  expect(pendingReferral(now + 2000)?.code).toBe("ABC");
  expect(pendingReferral(now + 30 * 86400000)).toBeNull();
});
it("rejects malformed capture and future/expired browser records", () => {
  expect(captureReferral("evil/code")).toBe(false);
  captureReferral("ABC", now + 1);
  expect(pendingReferral(now)).toBeNull();
});
it("formats arbitrary precise USDC micro-units without floating point", () => {
  expect(referralUnits("1000001")).toBe("1.000001");
  expect(referralUnits("340282366920938463463374607431768211455")).toBe(
    "340282366920938463463374607431768.211455",
  );
});
it("claims are disabled regardless of a positive balance; no new POST", async () => {
  const post = vi.spyOn(api, "post");
  await expect(
    referralClient(owner).createClaim({
      ...overview,
      balances: {
        ...overview.balances,
        available: "1000000",
        earned: "1000000",
      },
    }),
  ).rejects.toThrow("referral_payout_unavailable");
  expect(post).not.toHaveBeenCalled();
});
it("recovers the exact old key through GET even at zero current balance", async () => {
  claimJournal(owner()).save(claim.idempotencyKey);
  const get = vi.spyOn(api, "get").mockResolvedValue(claim);
  const post = vi.spyOn(api, "post");
  expect(await referralClient(owner).recoverClaim()).toEqual(claim);
  expect(get).toHaveBeenCalledWith(
    `/me/referral/claims/by-key/${claim.idempotencyKey}`,
  );
  expect(post).not.toHaveBeenCalled();
});
it("rejects recovered claim key substitution without leaking it into another owner journal", async () => {
  claimJournal(owner()).save(claim.idempotencyKey);
  vi.spyOn(api, "get").mockResolvedValue({
    ...claim,
    idempotencyKey: "30000000-0000-4000-8000-000000000001",
  });
  await expect(referralClient(owner).recoverClaim()).rejects.toThrow(
    "referral_record_mismatch",
  );
  expect(claimJournal({ ...owner(), identity: "bob" }).read()).toBeNull();
});
it("pins binding to the first owner and never automatically resends an uncertain bind", async () => {
  captureReferral("ABC");
  const post = vi.spyOn(api, "post").mockRejectedValue(new Error("lost"));
  await expect(referralClient(owner).bind(overview)).rejects.toThrow();
  await referralClient(owner).bind(overview);
  await referralClient(() => ({ ...owner(), identity: "bob" })).bind(overview);
  expect(post).toHaveBeenCalledOnce();
});
it("requires a known open server deadline and refuses self binding", async () => {
  captureReferral("ALICE");
  const post = vi.spyOn(api, "post");
  await referralClient(owner).bind(overview);
  captureReferral("ABC");
  await referralClient(owner).bind({ ...overview, bindOpenUntil: null });
  expect(post).not.toHaveBeenCalled();
});
it("rejects a stale owner at the actual POST boundary after token resolution", async () => {
  let identity = "alice";
  let release!: (s: string) => void;
  setAccessTokenGetter(
    () =>
      new Promise((r) => {
        release = r;
      }),
    "referral-race",
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const request = referralClient(() => ({ ...owner(), identity })).setCode(
    "NEWCODE",
  );
  await new Promise((r) => setTimeout(r, 0));
  identity = "bob";
  release("public-test-token");
  await expect(request).rejects.toThrow("referral_session_changed");
  expect(fetch).not.toHaveBeenCalled();
  setAccessTokenGetter(null, "referral-race-end");
  vi.unstubAllGlobals();
});

it("keeps an uncertain custom-code request immutable and only original GET can resolve it", async () => {
  const post = vi.spyOn(api, "post").mockRejectedValue(new Error("lost"));
  await expect(referralClient(owner).setCode("ORIGINAL")).rejects.toThrow();
  await expect(referralClient(owner).setCode("REPLACE")).rejects.toThrow(
    "referral_request_pending",
  );
  expect(post).toHaveBeenCalledOnce();
  vi.spyOn(api, "get").mockResolvedValue({
    ...overview,
    code: "ORIGINAL",
    link: "/r/ORIGINAL",
  });
  await referralClient(owner).recoverCode();
  expect(referralClient(owner).pendingCode()).toBeNull();
});
it("a definitive code rejection lets the owner correct the input while ambiguous responses keep the original journal", async () => {
  const { ApiError } = await import("@/lib/api");
  vi.spyOn(api, "post").mockRejectedValue(new ApiError(409, "taken"));
  await expect(referralClient(owner).setCode("TAKEN")).rejects.toThrow();
  expect(referralClient(owner).pendingCode()).toBeNull();
});
it("rechecks the known bind deadline after a delayed token; expired requests never reach HTTP", async () => {
  captureReferral("ABC");
  let release!: (s: string) => void;
  setAccessTokenGetter(
    () =>
      new Promise((r) => {
        release = r;
      }),
    "referral-bind",
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const request = referralClient(owner).bind(overview);
  await new Promise((r) => setTimeout(r, 0));
  vi.spyOn(Date, "now").mockReturnValue(now + 10001);
  release("public-test-token");
  await expect(request).rejects.toThrow("referral_bind_changed");
  expect(fetch).not.toHaveBeenCalled();
  setAccessTokenGetter(null, "referral-bind-end");
  vi.unstubAllGlobals();
});
it("reads an existing exact claim by id without creating or changing a payout request", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue(claim),
    post = vi.spyOn(api, "post");
  expect(await referralClient(owner).readClaim(claim)).toEqual(claim);
  expect(get).toHaveBeenCalledWith(`/me/referral/claims/${claim.id}`);
  expect(post).not.toHaveBeenCalled();
});
it("consumed invitation retains first-owner pin across reload and shared-browser account switching", async () => {
  captureReferral("ABC");
  vi.spyOn(api, "post").mockResolvedValue({
    bound: true,
    boundAt: new Date(now).toISOString(),
  });
  await referralClient(owner).bind(overview);
  captureReferral("ABC");
  await referralClient(() => ({ ...owner(), identity: "bob" })).bind(overview);
  expect(api.post).toHaveBeenCalledOnce();
  expect(pendingReferral()?.owner).toBe(JSON.stringify(["privy", "alice"]));
});
it("pins a captured invitation even when the first owner already has a referrer; it cannot migrate to another owner", async () => {
  captureReferral("ABC");
  const post = vi
    .spyOn(api, "post")
    .mockResolvedValue({ bound: true, boundAt: new Date(now).toISOString() });
  await referralClient(owner).bind({
    ...overview,
    referred: true,
    bindOpenUntil: null,
  });
  await referralClient(() => ({ ...owner(), identity: "bob" })).bind(overview);
  expect(post).not.toHaveBeenCalled();
});
it("a durable owner-pin failure closes binding before HTTP", async () => {
  captureReferral("ABC");
  const existing = window.localStorage;
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: existing.getItem.bind(existing),
    removeItem: existing.removeItem.bind(existing),
    setItem() {
      throw new Error("storage-denied");
    },
  } as unknown as Storage);
  const post = vi.spyOn(api, "post");
  await expect(referralClient(owner).bind(overview)).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});
it("refuses to replace an original claim journal with another request key", () => {
  const journal = claimJournal(owner());
  journal.save(claim.idempotencyKey);
  expect(() => journal.save("30000000-0000-4000-8000-000000000001")).toThrow(
    "referral_request_pending",
  );
  expect(journal.read()).toBe(claim.idempotencyKey);
});

it("keeps an unknown claim recoverable after a display identity changes under the same DID", () => {
  const original = { ...owner(), userId: "did:privy:stable" };
  claimJournal(original).save(claim.idempotencyKey);
  expect(claimJournal({ ...original, identity: "new-email" }).read()).toBe(claim.idempotencyKey);
  expect(claimJournal({ ...original, userId: "did:privy:another" }).read()).toBeNull();
});
it("preserves a legacy unknown claim when adopting a stable DID", async () => {
  claimJournal(owner()).save(claim.idempotencyKey);
  vi.spyOn(api, "get").mockResolvedValue(claim);
  const post = vi.spyOn(api, "post");
  expect(await referralClient(() => ({ ...owner(), userId: "did:privy:stable" })).recoverClaim()).toEqual(claim);
  expect(post).not.toHaveBeenCalled();
});

it("cannot send a new code when stable and legacy unresolved journals disagree", async () => {
  const account = { ...owner(), userId: "did:privy:stable" };
  localStorage.setItem('orbie.referral.code.v1:["privy","alice"]', JSON.stringify("OLDUNKNOWN"));
  localStorage.setItem('orbie.referral.code.v1:["privy","did:privy:stable"]', JSON.stringify("NEWUNKNOWN"));
  const post = vi.spyOn(api, "post").mockResolvedValue({ code: "THIRDCODE" });
  await expect(referralClient(() => account).setCode("THIRDCODE")).rejects.toThrow("referral_request_pending");
  expect(post).not.toHaveBeenCalled();
});

it("adopts a legacy journal once so subsequent email changes keep its unknown claim", () => {
  claimJournal(owner()).save(claim.idempotencyKey);
  const stable = { ...owner(), userId: "did:privy:stable" };
  expect(claimJournal(stable).read()).toBe(claim.idempotencyKey);
  expect(claimJournal({ ...stable, identity: "changed-email" }).read()).toBe(claim.idempotencyKey);
});
