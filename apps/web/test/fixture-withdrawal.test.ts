import { describe, expect, it, vi } from "vitest";

import { fixtureRequest } from "../src/fixtures/handler";
import { FIXTURE_WALLET_ADDRESS, fixtureSigner } from "../src/lib/fixture-signer";
import type { WalletWithdrawal, WalletWithdrawalClaim } from "@trading-dashboard/shared/contracts";

describe("fixture mode's withdrawal journal and signer", () => {
  it("reserves, claims once, accepts a signed submission and then has nothing pending", async () => {
    const op = await fixtureRequest<WalletWithdrawal>("POST", "/me/wallet/withdrawals", { destination: `0x${"22".repeat(20)}`, amount: "12.5" }, "fixture-token");
    expect(op).toMatchObject({ status: "prepared", address: FIXTURE_WALLET_ADDRESS, amount: "12.5" });
    await expect(fixtureRequest("POST", "/me/wallet/withdrawals", { destination: `0x${"22".repeat(20)}`, amount: "1" }, "fixture-token")).rejects.toMatchObject({ status: 409 });
    const claim = await fixtureRequest<WalletWithdrawalClaim>("POST", `/me/wallet/withdrawals/${op.id}/broadcast`, {}, "fixture-token");
    expect(claim).toMatchObject({ claimed: true, operation: { status: "unknown" } });
    expect((await fixtureRequest<WalletWithdrawalClaim>("POST", `/me/wallet/withdrawals/${op.id}/broadcast`, {}, "fixture-token")).claimed).toBe(false);
    const done = await fixtureRequest<WalletWithdrawal>("POST", `/me/wallet/withdrawals/${op.id}/submit`, { signature: `0x${"ab".repeat(65)}` }, "fixture-token");
    expect(done.status).toBe("accepted");
    expect(await fixtureRequest("GET", "/me/wallet/withdrawals/current", undefined, "fixture-token")).toBeNull();
  });

  it("gives a signer only in fixture mode and only when the URL asks for it", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_FIXTURES", "1");
    expect(fixtureSigner("?wallet=funded")).toBeNull();
    const signer = fixtureSigner("?wallet=funded&signer=fixture")!;
    expect(signer.address).toBe(FIXTURE_WALLET_ADDRESS);
    expect(await signer.signTypedData({ domain: { name: "x", version: "1", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: {}, primaryType: "X", message: {} })).toMatch(/^0x[0-9a-f]{130}$/);
    vi.stubEnv("NEXT_PUBLIC_API_FIXTURES", "");
    expect(fixtureSigner("?signer=fixture")).toBeNull();
    vi.unstubAllEnvs();
  });
});
