import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, rename, lstat, open, unlink, copyFile, constants } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const fail = code => { throw new Error(code); };
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function keys(privateKey) {
  try {
    const bytes = Buffer.from(privateKey, "base64");
    if (bytes.toString("base64") !== privateKey) fail("invalid_worker_key");
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !key.export({ format: "der", type: "pkcs8" }).equals(bytes)) fail("invalid_worker_key");
    return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
  } catch { fail("invalid_worker_key"); }
}
function verify(quorum, quorumId, publicKey) {
  if (!quorum || quorum.id !== quorumId || quorum.authorization_threshold !== 1 || !Array.isArray(quorum.authorization_keys) ||
      quorum.authorization_keys.length !== 1 || quorum.authorization_keys[0]?.public_key !== publicKey ||
      (quorum.user_ids != null && (!Array.isArray(quorum.user_ids) || quorum.user_ids.length)) ||
      (quorum.key_quorum_ids != null && (!Array.isArray(quorum.key_quorum_ids) || quorum.key_quorum_ids.length))) fail("worker_quorum_identity_mismatch");
}
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail("worker_secret_file_permissions");
}
async function atomic(path, value) {
  const temporary = `${path}.tmp.local`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Provision an unused worker quorum only. Never modifies any user wallet,
 * policy, agent approval, order or transfer. Secrets stay in ignored 0600 files.
 * Unknown POST outcomes remain unknown; subsequent runs cannot create again. */
export async function configureWorkerKey({ directory, appId, appSecret, provider }) {
  if (!appId || !appSecret) fail("privy_credentials_missing");
  const envPath = resolve(directory, ".env"), statePath = resolve(directory, ".env.copy-worker.local"), lockPath = resolve(directory, ".env.copy-worker-lock.local");
  const lock = await open(lockPath, "wx", 0o600).catch(() => fail("worker_setup_already_running"));
  try {
    await regular(envPath);
    const initial = await readFile(envPath, "utf8"), env = parseEnv(initial);
    if (env.PRIVY_APP_ID !== appId || env.PRIVY_APP_SECRET !== appSecret) fail("privy_environment_identity_changed");
    if (env.PRIVY_AGENT_AUTHORIZATION_KEY || env.PRIVY_AGENT_WORKER_QUORUM_ID) {
      if (!env.PRIVY_AGENT_AUTHORIZATION_KEY || !id(env.PRIVY_AGENT_WORKER_QUORUM_ID)) fail("worker_config_incomplete");
      const publicKey = keys(env.PRIVY_AGENT_AUTHORIZATION_KEY);
      verify(await provider.get(env.PRIVY_AGENT_WORKER_QUORUM_ID), env.PRIVY_AGENT_WORKER_QUORUM_ID, publicKey);
      return { configured: true, created: false, verified: true };
    }
    const appFingerprint = createHash("sha256").update(appId).digest("hex");
    let state;
    try { await regular(statePath); state = parseEnv(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const serialize = value => Object.entries(value).map(([key, value]) => `${key}=${value}\n`).join("");
    if (!state) {
      const generated = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { format: "der", type: "pkcs8" }, publicKeyEncoding: { format: "der", type: "spki" } });
      state = { APP_FINGERPRINT: appFingerprint, STATUS: "prepared", PRIVATE_KEY: generated.privateKey.toString("base64"), PUBLIC_KEY: generated.publicKey.toString("base64") };
      await writeFile(statePath, serialize(state), { flag: "wx", mode: 0o600 });
    }
    if (state.APP_FINGERPRINT !== appFingerprint || state.PUBLIC_KEY !== keys(state.PRIVATE_KEY)) fail("worker_setup_identity_changed");
    let created = false;
    if (state.STATUS === "prepared") {
      state.STATUS = "unknown"; await atomic(statePath, serialize(state));
      let response;
      try { response = await provider.create({ authorization_threshold: 1, public_keys: [state.PUBLIC_KEY], display_name: "Copy testnet worker" }); }
      catch { fail("worker_quorum_creation_unknown"); }
      if (!id(response?.id)) fail("worker_quorum_creation_unknown");
      state.QUORUM_ID = response.id; state.STATUS = "created"; await atomic(statePath, serialize(state)); created = true;
    }
    if (state.STATUS !== "created" || !id(state.QUORUM_ID)) fail("worker_quorum_creation_unknown");
    verify(await provider.get(state.QUORUM_ID), state.QUORUM_ID, state.PUBLIC_KEY);
    // Refuse concurrent edits to .env; preserve all unrelated configuration.
    if (await readFile(envPath, "utf8") !== initial) fail("environment_changed_during_worker_setup");
    await copyFile(envPath, resolve(directory, ".env.before-copy-worker.local"), constants.COPYFILE_EXCL).catch(error => { if (error.code !== "EEXIST") throw error; });
    await atomic(envPath, `${initial.trimEnd()}\nPRIVY_AGENT_AUTHORIZATION_KEY=${state.PRIVATE_KEY}\nPRIVY_AGENT_WORKER_QUORUM_ID=${state.QUORUM_ID}\n`);
    return { configured: true, created, verified: true };
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
    const { PrivyClient } = await import(pathToFileURL(require.resolve("@privy-io/node")).href);
    const client = new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET, maxRetries: 0, timeout: 10_000 });
    const result = await configureWorkerKey({ directory: process.cwd(), appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET,
      provider: { create: body => client.keyQuorums().create(body), get: id => client.keyQuorums().get(id) } });
    console.log(JSON.stringify(result));
  } catch (error) {
    const codes = new Set(["invalid_worker_key", "worker_quorum_identity_mismatch", "worker_secret_file_permissions", "privy_credentials_missing",
      "worker_setup_already_running", "privy_environment_identity_changed", "worker_config_incomplete", "worker_setup_identity_changed",
      "worker_quorum_creation_unknown", "environment_changed_during_worker_setup"]);
    console.error(codes.has(error?.message) ? error.message : "worker_setup_unavailable"); process.exitCode = 1;
  }
}
