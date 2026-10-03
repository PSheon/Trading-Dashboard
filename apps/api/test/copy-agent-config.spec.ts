import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEnvironment } from "../src/config/runtime-config.js";

const base = { DATABASE_URL: "postgres://test@localhost/test", PRIVY_APP_ID: "app-test", PRIVY_APP_SECRET: "test-secret" };
function keys(curve = "prime256v1") {
  const pair = generateKeyPairSync("ec", { namedCurve: curve });
  return { privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
describe("agent signer deployment configuration", () => {
  it("defaults to no agent capability and cannot use the Privy app secret as a signing key", () => {
    expect(validateEnvironment(base).copy.agent).toBeUndefined();
    expect(() => validateEnvironment({ ...base, PRIVY_AGENT_AUTHORIZATION_KEY: "test-secret", PRIVY_AGENT_WORKER_QUORUM_ID: "quorum" })).toThrow("PRIVY_AGENT_AUTHORIZATION_KEY");
  });
  it("requires all dependencies and a canonical P256 PKCS8 authorization key", () => {
    const pair = keys();
    expect(() => validateEnvironment({ ...base, PRIVY_AGENT_AUTHORIZATION_KEY: pair.privateKey })).toThrow("set together");
    expect(() => validateEnvironment({ ...base, PRIVY_AGENT_WORKER_QUORUM_ID: "quorum" })).toThrow("set together");
    expect(() => validateEnvironment({ ...base, PRIVY_AGENT_AUTHORIZATION_KEY: keys("secp256k1").privateKey, PRIVY_AGENT_WORKER_QUORUM_ID: "quorum" })).toThrow("P256");
    expect(() => validateEnvironment({ DATABASE_URL: base.DATABASE_URL, PRIVY_AGENT_AUTHORIZATION_KEY: pair.privateKey, PRIVY_AGENT_WORKER_QUORUM_ID: "quorum" })).toThrow("Privy credentials");
    expect(validateEnvironment({ ...base, PRIVY_AGENT_AUTHORIZATION_KEY: pair.privateKey, PRIVY_AGENT_WORKER_QUORUM_ID: "quorum" }).copy.agent)
      .toEqual({ authorizationPrivateKey: pair.privateKey, authorizationPublicKey: pair.publicKey, workerQuorumId: "quorum" });
  });
});
