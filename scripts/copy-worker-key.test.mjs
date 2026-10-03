import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { configureWorkerKey } from "./copy-worker-key.mjs";

async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), "copy-worker-key-"));
  await writeFile(join(directory, ".env"), "PRIVY_APP_ID=fixture-app\nPRIVY_APP_SECRET=fixture-secret\nCOPY_TRADING_MODE=paper\n", { mode: 0o600 });
  try { await work(directory, provider => configureWorkerKey({ directory, appId: "fixture-app", appSecret: "fixture-secret", provider })); }
  finally { await rm(directory, { recursive: true }); }
}
test("durable key precedes creation; only public key reaches provider; rerun verifies without recreation", async () => fixture(async (dir, run) => {
  let count = 0, publicKey;
  const provider = { create: async body => {
    count++; assert.deepEqual(Object.keys(body).sort(), ["authorization_threshold", "display_name", "public_keys"]);
    const state = parseEnv(await readFile(join(dir, ".env.copy-worker.local"), "utf8"));
    assert.equal(state.STATUS, "unknown"); assert.equal((await stat(join(dir, ".env.copy-worker.local"))).mode & 0o777, 0o600);
    assert.ok(state.PRIVATE_KEY); publicKey = body.public_keys[0]; assert.equal(state.PUBLIC_KEY, publicKey); return { id: "new-quorum" };
  }, get: async id => ({ id, authorization_threshold: 1, authorization_keys: [{ public_key: publicKey }], user_ids: [], key_quorum_ids: [] }) };
  assert.deepEqual(await run(provider), { configured: true, created: true, verified: true });
  assert.deepEqual(await run(provider), { configured: true, created: false, verified: true }); assert.equal(count, 1);
  const env = parseEnv(await readFile(join(dir, ".env"), "utf8")); assert.equal(env.COPY_TRADING_MODE, "paper"); assert.equal(env.PRIVY_AGENT_WORKER_QUORUM_ID, "new-quorum");
}));
test("unknown creation never repeats and never installs incomplete credentials", async () => fixture(async (dir, run) => {
  let count = 0; const provider = { create: async () => { count++; throw Error("remote secret raw timeout"); }, get: async () => assert.fail("no id to verify") };
  await assert.rejects(run(provider), /worker_quorum_creation_unknown/); await assert.rejects(run(provider), /worker_quorum_creation_unknown/); assert.equal(count, 1);
  assert.equal(parseEnv(await readFile(join(dir, ".env"), "utf8")).PRIVY_AGENT_AUTHORIZATION_KEY, undefined);
}));
test("failed verification of a known quorum resumes GET only", async () => fixture(async (dir, run) => {
  let publicKey, count = 0, healthy = false;
  const provider = { create: async body => { count++; publicKey = body.public_keys[0]; return { id: "quorum" }; }, get: async id => {
    if (!healthy) throw Error("unavailable"); return { id, authorization_threshold: 1, authorization_keys: [{ public_key: publicKey }], user_ids: null };
  } };
  await assert.rejects(run(provider)); healthy = true; await run(provider); assert.equal(count, 1);
}));
test("unexpected additional user authority cannot install worker configuration", async () => fixture(async (dir, run) => {
  let publicKey; const provider = { create: async body => { publicKey = body.public_keys[0]; return { id: "quorum" }; },
    get: async id => ({ id, authorization_threshold: 1, authorization_keys: [{ public_key: publicKey }], user_ids: ["unexpected-user"] }) };
  await assert.rejects(run(provider), /worker_quorum_identity_mismatch/);
  assert.equal(parseEnv(await readFile(join(dir, ".env"), "utf8")).PRIVY_AGENT_AUTHORIZATION_KEY, undefined);
}));
