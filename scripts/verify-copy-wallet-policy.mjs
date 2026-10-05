/**
 * Stage check after a real one-click setup (docs/one-click-copy-plan-2026-10-05.md
 * §5 "Stage end-to-end", step 8): on the owner's actual copy wallet, the
 * worker quorum's key may sign only what the owner's policy allows.
 *
 * Signatures only: nothing is posted to Hyperliquid, and a testnet UsdSend
 * signature moves nothing until it is posted. Read-only otherwise (wallet and
 * policy GETs). Credentials are read in-process from the Stage api service
 * (`railway variables --json`), never printed.
 *
 * Expected:
 *   signers         the wallet's only additional signer is the worker quorum
 *                   with exactly one override policy; no wallet-level policy
 *   allow_return    UsdSend of 1 USDC to the owner's main wallet on Testnet → signed
 *   deny_other      UsdSend to any other address → denied
 *   deny_mixed_case the same destination in mixed case → denied
 *   deny_mainnet    UsdSend on Mainnet / chainId 42161 → denied
 *   deny_withdraw   Withdraw (to the owner's main wallet) → denied
 *   deny_agent      ApproveAgent for an agent nobody consented to → denied
 *   deny_unified    UserSetAbstraction to unifiedAccount → denied
 *
 * Run (the wallet id and owner main wallet from the Stage DB:
 *   select privy_wallet_id, address, sweep_destination from copy_execution_accounts where master_policy_id is not null;):
 *   COPY_WALLET_ID=<privy wallet id> OWNER_MAIN=<0x… owner main, lowercase> node scripts/verify-copy-wallet-policy.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrivyClient } = require('@privy-io/node');
const { verifyTypedData } = require('viem');

const walletId = process.env.COPY_WALLET_ID, ownerMain = process.env.OWNER_MAIN?.toLowerCase();
if (!walletId || !/^0x[0-9a-f]{40}$/.test(ownerMain ?? '')) throw new Error('Set COPY_WALLET_ID and OWNER_MAIN');
const root = new URL('../', import.meta.url);
const vars = JSON.parse(execFileSync('railway', ['variables', '--service', 'api', '--environment', 'Stage', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const { PRIVY_APP_ID: appId, PRIVY_APP_SECRET: appSecret, PRIVY_AGENT_WORKER_QUORUM_ID: quorumId, PRIVY_AGENT_AUTHORIZATION_KEY: workerKey } = vars;
if (!appId || !appSecret || !quorumId || !workerKey) throw new Error('Stage Privy credentials missing');
const client = new PrivyClient({ appId, appSecret, logLevel: 'off', maxRetries: 0, timeout: 20_000 });
const reason = (error) => String(error?.error?.error ?? error?.message ?? error).slice(0, 160);
let failures = 0;
const record = (check, pass, evidence = {}) => { if (!pass) failures++; console.log(JSON.stringify({ check, pass, ...evidence })); };

const wallet = await client.wallets().get(walletId);
const signers = wallet.additional_signers ?? [];
record('signers', signers.length === 1 && signers[0].signer_id === quorumId && (signers[0].override_policy_ids ?? []).length === 1 && !(wallet.policy_ids ?? []).length,
  { address: wallet.address, signers: signers.map(s => ({ quorum: s.signer_id === quorumId ? 'worker' : 'OTHER', policies: (s.override_policy_ids ?? []).length })), walletPolicies: (wallet.policy_ids ?? []).length });

const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const TYPES = {
  'HyperliquidTransaction:UsdSend': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:Withdraw': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:ApproveAgent': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }],
  'HyperliquidTransaction:UserSetAbstraction': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'user', type: 'address' }, { name: 'abstraction', type: 'string' }, { name: 'nonce', type: 'uint64' }],
};
const typed = (primary, message, chainId = 421614) => ({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: `0x${'00'.repeat(20)}` },
  types: { EIP712Domain: DOMAIN, [primary]: TYPES[primary] }, primary_type: primary, message });
async function sign(data) {
  try { return { ok: true, signature: (await client.wallets().ethereum().signTypedData(walletId, { params: { typed_data: data }, authorization_context: { authorization_private_keys: [workerKey] } })).signature }; }
  catch (error) { return { ok: false, error: reason(error) }; }
}
const now = Date.now(), other = `0x${'6b'.repeat(20)}`;

const allowed = typed('HyperliquidTransaction:UsdSend', { hyperliquidChain: 'Testnet', destination: ownerMain, amount: '1', time: now });
const result = await sign(allowed);
const recovers = result.ok && await verifyTypedData({ address: wallet.address, domain: allowed.domain, types: { [allowed.primary_type]: allowed.types[allowed.primary_type] },
  primaryType: allowed.primary_type, message: allowed.message, signature: result.signature }).catch(() => false);
record('allow_return', Boolean(recovers), result.ok ? { recoversToCopyWallet: recovers } : { error: result.error });

const denied = {
  deny_other: typed('HyperliquidTransaction:UsdSend', { hyperliquidChain: 'Testnet', destination: other, amount: '1', time: now }),
  deny_mixed_case: typed('HyperliquidTransaction:UsdSend', { hyperliquidChain: 'Testnet', destination: ownerMain.replace(/[a-f]/, c => c.toUpperCase()), amount: '1', time: now }),
  deny_mainnet: typed('HyperliquidTransaction:UsdSend', { hyperliquidChain: 'Mainnet', destination: ownerMain, amount: '1', time: now }, 42161),
  deny_withdraw: typed('HyperliquidTransaction:Withdraw', { hyperliquidChain: 'Testnet', destination: ownerMain, amount: '1', time: now }),
  deny_agent: typed('HyperliquidTransaction:ApproveAgent', { hyperliquidChain: 'Testnet', agentAddress: other, agentName: `copy0 valid_until ${now + 86_400_000}`, nonce: now }),
  deny_unified: typed('HyperliquidTransaction:UserSetAbstraction', { hyperliquidChain: 'Testnet', user: wallet.address.toLowerCase(), abstraction: 'unifiedAccount', nonce: now }),
};
for (const [check, data] of Object.entries(denied)) {
  const outcome = await sign(data);
  record(check, !outcome.ok, outcome.ok ? { error: 'SIGNED: the policy allowed it' } : { denied: outcome.error });
}
console.log(JSON.stringify({ done: true, failures }));
process.exit(failures ? 1 : 0);
