import { describe, expect, it, vi } from "vitest";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { CopyAccountModeRepository } from "../src/copy/copy-account-mode.repository.js";
import { lockCopyUser } from "../src/copy/copy-user-lock.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { DrizzleDb } from "../src/db/drizzle.provider.js";
import type { DbTransaction } from "../src/db/unit-of-work.js";

/** G8: every (7404, userId) acquirer refuses a key outside users.id before
 * reaching Postgres, so a missing or zero id can never take a shared lock. */
const invalid = [0, -1, 1.5, Number.NaN, 2 ** 31];
const fakeTx = () => ({ execute: vi.fn(async () => ({ rows: [] })) });
const asTx = (tx: ReturnType<typeof fakeTx>) => tx as unknown as DbTransaction;

describe("COPY_USER advisory lock identity", () => {
  it.each(invalid)("lockCopyUser helper rejects %s", async (userId) => {
    const tx = fakeTx();
    await expect(lockCopyUser(asTx(tx), userId)).rejects.toThrow(/copy user lock identity/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it.each(invalid)("CopyRepository.lockCopyUser rejects %s", async (userId) => {
    const tx = fakeTx();
    await expect(new CopyRepository({} as DrizzleDb).lockCopyUser(asTx(tx), userId)).rejects.toThrow(/copy user lock identity/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it.each(invalid)("CopyRepository.readControls(share) rejects %s", async (userId) => {
    const tx = fakeTx();
    await expect(new CopyRepository({} as DrizzleDb).readControls(userId, "share", asTx(tx))).rejects.toThrow(/copy user lock identity/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it.each(invalid)("CopyAccountModeRepository.owner (locking) rejects %s", async (userId) => {
    const tx = fakeTx();
    const repository = new CopyAccountModeRepository({} as DrizzleDb, {} as AppConfig);
    await expect(repository.owner(userId, asTx(tx))).rejects.toThrow(/copy user lock identity/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("a valid user id still takes (7404, userId)", async () => {
    const tx = fakeTx();
    await new CopyRepository({} as DrizzleDb).lockCopyUser(asTx(tx), 42);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});
