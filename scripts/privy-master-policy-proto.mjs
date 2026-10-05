/**
 * Prototype for the one-click copy plan §2 ("Which steps the worker quorum can
 * sign") on the Stage **Dev** Privy app. Proves, against Privy itself:
 *  (a) a user-owned policy can be created;
 *  (b) `wallets().update` with the owner's `user_jwts` attaches the worker
 *      quorum with `override_policy_ids: [P]` to a server-created user-owned
 *      wallet;
 *  (c) the override policy binds only the additional signer: the owner's own
 *      JWT still signs anything;
 *  (d) typed-data conditions match Hyperliquid's `destination` string exactly
 *      (lowercase);
 *  (e) the worker key is denied a UsdSend to any other address, any other
 *      primary type, and mainnet.
 *
 * Nothing is sent to Hyperliquid: only signatures are requested, and a
 * signature over a testnet UsdSend moves nothing until it is posted.
 *
 * Credentials: PRIVY_APP_ID / PRIVY_APP_SECRET are read from the Stage api
 * service in-process (`railway variables --json`, never printed); the worker
 * quorum key from the gitignored `.env.copy-worker.stage.local`. The owner is
 * the Dev app's Privy **test account** (`apps().getTestAccessToken()`, Privy's
 * mechanism for automated tests); or pass `PRIVY_PROTO_JWT_FILE` holding a signed-in
 * user's access token (Paul's browser `privy:token`) instead.
 *
 * Objects it creates are labelled `orbie-proto-…`. Run:
 *   node scripts/privy-master-policy-proto.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrivyClient } = require('@privy-io/node');
const { verifyTypedData } = require('viem');
// The production rules (build the api first: pnpm turbo run build --filter=@trading-dashboard/api).
const { masterPolicyRules, MASTER_POLICY_TYPES } = await import(new URL('../apps/api/dist/copy/live/privy-master-policy.js', import.meta.url).href);

const root = new URL('../', import.meta.url);
const vars = JSON.parse(execFileSync('railway', ['variables', '--service', 'api', '--environment', 'Stage', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const workerEnv = Object.fromEntries(readFileSync(new URL('.env.copy-worker.stage.local', root), 'utf8').split('\n')
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
const appId = vars.PRIVY_APP_ID, appSecret = vars.PRIVY_APP_SECRET;
const quorumId = vars.PRIVY_AGENT_WORKER_QUORUM_ID, workerKey = vars.PRIVY_AGENT_AUTHORIZATION_KEY;
if (!appId || !appSecret || !quorumId || !workerKey) throw new Error('Stage Privy credentials missing');
if (workerEnv.QUORUM_ID && workerEnv.QUORUM_ID !== quorumId) throw new Error('Local worker quorum differs from Stage');
const client = new PrivyClient({ appId, appSecret, logLevel: 'off', maxRetries: 0, timeout: 20_000 });
const label = `orbie-proto-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const results = {}, created = [];
const record = (key, pass, evidence) => { results[key] = { pass, ...evidence }; console.log(JSON.stringify({ check: key, pass, ...evidence })); };
const reason = (error) => String(error?.error?.error ?? error?.message ?? error).slice(0, 200);

// --- the owner ------------------------------------------------------------
async function ownerSession() {
  if (process.env.PRIVY_PROTO_JWT_FILE) {
    const token = readFileSync(process.env.PRIVY_PROTO_JWT_FILE, 'utf8').trim().replace(/^"|"$/g, '');
    const claims = await client.utils().auth().verifyAccessToken(token);
    return { token, userId: claims.user_id };
  }
  // Privy's own test-account login for automated tests (Dev app test accounts).
  try {
    const { access_token: token } = await client.apps().getTestAccessToken();
    const claims = await client.utils().auth().verifyAccessToken(token);
    return { token, userId: claims.user_id };
  } catch {
    // No test accounts on the app: a labelled server-created user, without a
    // session. (b) and (c) then need PRIVY_PROTO_JWT_FILE or test accounts.
    const user = await client.users().create({ linked_accounts: [{ type: 'email', address: `${label}@example.invalid` }] });
    created.push({ kind: 'user', id: user.id });
    return { token: null, userId: user.id };
  }
}

// --- the master policy (plan §2, rules 1–3 and 5; rule 4 omitted: fee 0) ----
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const TYPES = {
  'HyperliquidTransaction:UsdSend': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:ApproveAgent': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }],
  'HyperliquidTransaction:Withdraw': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
};
Object.assign(TYPES, MASTER_POLICY_TYPES);
const TESTNET_CHAIN_ID = 421614, ZERO = `0x${'00'.repeat(20)}`;
const message = (primary, field, value) => ({ field_source: 'ethereum_typed_data_message', field, operator: 'eq', value,
  typed_data: { primary_type: primary, types: { EIP712Domain: DOMAIN, [primary]: TYPES[primary] } } });
const domain = [
  { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: String(TESTNET_CHAIN_ID) },
  { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: ZERO },
];
function protoRules(ownerMain, agent) {
  return [
    { name: 'UsdSend to the owner main wallet on testnet', method: 'eth_signTypedData_v4', action: 'ALLOW', conditions: [...domain,
      message('HyperliquidTransaction:UsdSend', 'destination', ownerMain.toLowerCase()), message('HyperliquidTransaction:UsdSend', 'hyperliquidChain', 'Testnet')] },
    { name: 'ApproveAgent for the consented agent and expiry', method: 'eth_signTypedData_v4', action: 'ALLOW', conditions: [...domain,
      message('HyperliquidTransaction:ApproveAgent', 'agentAddress', agent.address.toLowerCase()), message('HyperliquidTransaction:ApproveAgent', 'agentName', agent.name),
      message('HyperliquidTransaction:ApproveAgent', 'hyperliquidChain', 'Testnet')] },
    { name: 'Deny key export', method: 'exportPrivateKey', action: 'DENY', conditions: [] },
    { name: 'Deny seed export', method: 'exportSeedPhrase', action: 'DENY', conditions: [] },
  ];
}
const typed = (primary, msg, chainId = TESTNET_CHAIN_ID) => ({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: ZERO },
  types: { EIP712Domain: DOMAIN, [primary]: TYPES[primary] }, primary_type: primary, message: msg });

async function sign(walletId, data, authorization) {
  try {
    const result = await client.wallets().ethereum().signTypedData(walletId, { params: { typed_data: data }, authorization_context: authorization });
    return { ok: true, signature: result.signature };
  } catch (error) { return { ok: false, error: reason(error) }; }
}

const owner = await ownerSession();
console.log(JSON.stringify({ owner: owner.userId.replace(/^(did:privy:.{4}).*$/, '$1…'), label }));
const ownerMain = `0x${'5a'.repeat(20)}`, other = `0x${'6b'.repeat(20)}`;
const agent = { address: `0x${'7c'.repeat(20)}`, name: `copy0 valid_until ${Date.now() + 30 * 86_400_000}` };
const worker = { authorization_private_keys: [workerKey] }, ownerAuth = { user_jwts: [owner.token] };
// UserSetAbstraction's `user` (the copy account) isn't known before the wallet
// exists; the rule's matching is what is tested here.
const accountForPolicy = `0x${'8d'.repeat(20)}`;

// (a) a user-owned policy
let policy;
try {
  policy = await client.policies().create({ version: '1.0', name: label, chain_type: 'ethereum', owner: { user_id: owner.userId }, rules: masterPolicyRules({ ownerMain, account: accountForPolicy, agent }) });
  created.push({ kind: 'policy', id: policy.id });
  record('a_user_owned_policy', typeof policy.owner_id === 'string' && policy.owner_id.length > 0, { policyId: policy.id, ownerQuorum: policy.owner_id, rules: policy.rules.length });
} catch (error) { record('a_user_owned_policy', false, { error: reason(error) }); throw error; }

// A server-created, user-owned copy wallet with no signers (as copy-wallet.service creates them).
// Without the owner's session the signer is attached at creation (app secret,
// as the agent wallets are): (d) and (e) still test the policy itself.
const wallet = await client.wallets().create({ chain_type: 'ethereum', owner: { user_id: owner.userId }, display_name: label, external_id: label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
  ...(owner.token ? {} : { additional_signers: [{ signer_id: quorumId, override_policy_ids: [policy.id] }] }) });
created.push({ kind: 'wallet', id: wallet.id, address: wallet.address });
console.log(JSON.stringify({ wallet: wallet.id, address: wallet.address, signersBefore: wallet.additional_signers ?? [] }));

// (b) attach the worker quorum with the override policy, authorised by the owner's session
if (!owner.token) record('b_attach_with_owner_jwt', null, { skipped: 'no owner session: enable test accounts on the Dev app or pass PRIVY_PROTO_JWT_FILE' });
else try {
  const updated = await client.wallets().update(wallet.id, { authorization_context: ownerAuth, additional_signers: [{ signer_id: quorumId, override_policy_ids: [policy.id] }] });
  const signers = updated.additional_signers ?? [];
  record('b_attach_with_owner_jwt', signers.length === 1 && signers[0].signer_id === quorumId && JSON.stringify(signers[0].override_policy_ids) === JSON.stringify([policy.id]) && !(updated.policy_ids?.length),
    { additionalSigners: signers, walletPolicyIds: updated.policy_ids ?? [] });
} catch (error) { record('b_attach_with_owner_jwt', false, { error: reason(error) }); }
// The app secret alone must not be able to do the same.
if (owner.token) try {
  await client.wallets().update(wallet.id, { additional_signers: [{ signer_id: quorumId, override_policy_ids: [] }] });
  record('b_app_secret_alone_refused', false, { error: 'update without the owner succeeded' });
} catch (error) { record('b_app_secret_alone_refused', true, { error: reason(error) }); }

// (d) the worker signs exactly the policy's UsdSend; exact lowercase match
const send = (destination, chain = 'Testnet', chainId) => typed('HyperliquidTransaction:UsdSend', { hyperliquidChain: chain, destination, amount: '1', time: Date.now() }, chainId);
const toOwner = send(ownerMain), allowed = await sign(wallet.id, toOwner, worker);
let recovers = false;
if (allowed.ok) { const d = toOwner; try { recovers = await verifyTypedData({ address: wallet.address, domain: d.domain, types: { [d.primary_type]: d.types[d.primary_type] }, primaryType: d.primary_type, message: d.message, signature: allowed.signature }); } catch { /* reported */ } }
record('d_worker_usdsend_to_owner_allowed', allowed.ok, { error: allowed.error });
const checksummed = ownerMain.replace('0x', '0x').split('').map((c, i) => (i > 1 && /[a-f]/.test(c) && i % 2 ? c.toUpperCase() : c)).join('');
const mixed = await sign(wallet.id, send(checksummed), worker);
record('d_destination_match_is_exact_lowercase', !mixed.ok, { mixedCaseDenied: !mixed.ok, error: mixed.error });

// (e) everything else is denied for the worker key
const deniedOther = await sign(wallet.id, send(other), worker);
const deniedMainnet = await sign(wallet.id, send(ownerMain, 'Mainnet', 42161), worker);
const deniedWithdraw = await sign(wallet.id, typed('HyperliquidTransaction:Withdraw', { hyperliquidChain: 'Testnet', destination: ownerMain, amount: '1', time: Date.now() }), worker);
const deniedAgent = await sign(wallet.id, typed('HyperliquidTransaction:ApproveAgent', { hyperliquidChain: 'Testnet', agentAddress: other, agentName: agent.name, nonce: Date.now() }), worker);
const allowedAgent = await sign(wallet.id, typed('HyperliquidTransaction:ApproveAgent', { hyperliquidChain: 'Testnet', agentAddress: agent.address, agentName: agent.name, nonce: Date.now() }), worker);
let personal = { ok: false };
try { await client.wallets().ethereum().signMessage(wallet.id, { message: 'orbie-proto', authorization_context: worker }); personal = { ok: true }; } catch (error) { personal = { ok: false, error: reason(error) }; }
record('e_worker_denied_elsewhere', !deniedOther.ok && !deniedMainnet.ok && !deniedWithdraw.ok && !deniedAgent.ok && !personal.ok,
  { otherDestination: deniedOther.error ?? 'ALLOWED', mainnet: deniedMainnet.error ?? 'ALLOWED', withdraw: deniedWithdraw.error ?? 'ALLOWED', otherAgent: deniedAgent.error ?? 'ALLOWED', personalSign: personal.error ?? 'ALLOWED' });
record('e_worker_consented_agent_allowed', allowedAgent.ok, { error: allowedAgent.error });
const mode = (user, abstraction) => typed('HyperliquidTransaction:UserSetAbstraction', { hyperliquidChain: 'Testnet', user, abstraction, nonce: Date.now() });
const modeAllowed = await sign(wallet.id, mode(accountForPolicy, 'disabled'), worker);
const modeOther = await sign(wallet.id, mode(accountForPolicy, 'unifiedAccount'), worker);
const modeForeign = await sign(wallet.id, mode(other, 'disabled'), worker);
record('e_worker_account_mode_only_disabled', modeAllowed.ok && !modeOther.ok && !modeForeign.ok, { disabled: modeAllowed.error ?? 'allowed', unified: modeOther.error ?? 'ALLOWED', otherUser: modeForeign.error ?? 'ALLOWED' });

// (c) the owner's own session is not bound by the signer's override policy
if (!owner.token) record('c_owner_unrestricted', null, { skipped: 'no owner session' });
else {
const ownerOther = await sign(wallet.id, send(other), ownerAuth);
const ownerWithdraw = await sign(wallet.id, typed('HyperliquidTransaction:Withdraw', { hyperliquidChain: 'Testnet', destination: other, amount: '1', time: Date.now() }), ownerAuth);
record('c_owner_unrestricted', ownerOther.ok && ownerWithdraw.ok, { otherDestination: ownerOther.error ?? 'allowed', withdraw: ownerWithdraw.error ?? 'allowed' });
}

console.log(JSON.stringify({ summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.pass])), signatureRecovers: recovers, created }));
