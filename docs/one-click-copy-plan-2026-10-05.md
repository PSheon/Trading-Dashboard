<!-- Read-only analysis requested by Paul on 2026-10-05: 「你分析一下哪邊要修改？」 (one-click testnet copy like CopyDog). Decisions pending; see the end. -->

# Plan: one-click testnet copy (CopyDog-style) for Orbie

I didn't modify anything. Repo is at `dev` 6c7ece46. Two corrections to the brief up front:
- The mainnet-source filter is at `apps/web/src/components/settings/execution-wallets.tsx:33`, not :32.
- Some docs are out of date. `apps/api/src/copy/live/README.md:120` and gap-audit B1 say runtime rejects `COPY_TRADING_MODE=testnet`. In fact `apps/api/src/config/runtime-config.ts:87-95` accepts it (only `live` is refused). Fix those docs in the first commit.

---

## 1. Target UX

**What CopyDog does (from repo evidence; nobody has used CopyDog signed in, see `docs/copydog-feature-parity-2026-10-02.md` §How this was checked):**
- The widget posts `{trader_address, allocation_mode:"ratio", allocation_amount, max_total_exposure, max_leverage, copy_direction, copy_start_mode:"adopt"}` to `POST /api/copy-trading/configure`.
- Minimum is $100.
- Funding runs on the server from the main ("hub") balance. The front end handles `funding_error_code`, `insufficient_main_balance`, `awaiting_credit_confirmation` and `funding=pending`.
- Portfolio states are `needs_deposit`/`funding`/`paused`/`sweeping`.
- Other actions: `hl-vault/{id}/topup`, `hl-vault/{id}/withdraw` (`no_free_collateral`), `/stop-and-close`, `/close-hl-position`. Stop closes positions and sweeps everything back to the main wallet (`docs/copydog-copy-trading-mechanics-2026-10-02.md` §4).
- No CopyDog signing prompt is documented. Its deposit bridge was signed server-side with no user action (`docs/copydog-deposit-mechanics-2026-10-04.md`). The best inference is that CopyDog shows no wallet prompts at all.

**Orbie target flow:**
1. **Trader page → 跟單 panel** (`components/trader/copy-panel.tsx`). Add a two-option pill **模擬 / 測試網** above 順向/反向.
   - Show it only when the user is signed in with Privy and `GET /me/copy/live` reports `capabilities.automaticExecution` (`copy-live-mandate.service.ts:43`).
   - Default is 模擬; the choice is remembered per user.
   - In 測試網 mode:
     - The balance line shows the main wallet's Hyperliquid testnet withdrawable (`lib/wallet.ts:26 useWallet`), not the paper balance.
     - The amount is the budget, minimum `limits.minAllocationUsd` (100 by default, `packages/shared/src/schema/copy.ts:69`).
     - 更多設定 shows: sizing (ratio/fixed + per-trade), max exposure, max leverage.
     - 跟單目前持倉 is shown off and disabled with a note. Testnet only supports `delta`: `copy-live.tsx:45`, `postgres-live-risk-authority.ts:54`.
     - Source network is implicit `mainnet` (trader pages are mainnet addresses).
2. **CTA 開始跟單 $X → Orbie confirm sheet.** One Orbie screen lists: trader, budget, direction/sizing, "testnet funds", the agent's expiry, the builder fee cap (if any), and "on stop, positions close and funds return automatically to your main wallet". One button: **確認並開始**.
3. **Two silent signatures** behind that button: the setup consent (EIP-712) and the Hyperliquid `UsdSend` main → copy account.
   - This is possible with the installed SDK. `@privy-io/react-auth` 3.46.0 has `signTypedData(input, { uiOptions?: { showWalletUIs?: boolean }, address? })` (`node_modules/@privy-io/react-auth/dist/dts/index.d.ts:3548-3557`).
   - `SignMessageModalUIOptions.showWalletUIs` overrides the Privy dashboard default for one call (`types-BOEI6Njl.d.ts:2376-2382`). It can also be set globally with `config.embeddedWallets.showWalletUIs` (`types-BOEI6Njl.d.ts:1826-1833`).
   - Today `auth-privy.tsx:165-168` passes only `{address}`, and the `PrivyProvider` config (`auth-privy.tsx:47-66`) doesn't set `showWalletUIs`. So today every signature opens Privy's modal, assuming the dashboard default (not recorded in docs).
   - Caveat: a user who enrolled Privy MFA for wallet actions still gets a prompt.
4. **Progress dialog** (new). Stages:
   1. 準備錢包
   2. 入金送出 → 已入帳
   3. 帳戶設定 (mode)
   4. 交易代理授權
   5. (費用授權)
   6. 開始跟單
   
   It shows an error with retry where possible. Closing it is safe: the server continues, and the portfolio row shows the same stages (`liveCopyStageSchema` already exists, `packages/shared/src/copy-live-mandate-contracts.ts:89-90`).
5. **Running.** The trader panel shows "跟單中 · 測試網" with budget, PnL and positions, plus 管理 → portfolio.
   - The portfolio row (`components/copy/live-copies.tsx`) gets:
     - **暫停 / 恢復**: no signature.
     - **編輯設定**: one silent signature for a new mandate generation.
     - **加碼**: one silent `UsdSend`.
     - **提領閒置資金**: no signature, because it can only go to the owner's main wallet (see §2).
     - **平倉單一部位**: exists today.
     - **停止**.
6. **Stop**: no signatures. Request → (cancel tracked orders) → reduce-only close → flat → **automatic** `usdSend` copy → main → credited → 已停止. The row shows 停止中 → 資金返還中 → 已停止, with the returned amount.

**Signature count:**

| Action | Today | Target |
|---|---|---|
| Start | 4–5 signatures: funding, mode consent, agent consent, (builder consent), mandate consent. Each is a Privy modal across separate Settings sections, with ~12 clicks and 5-minute windows. | 2 silent signatures, 1 Orbie confirm |
| Stop | 0–2: cancellation consent if orders are resting, plus the return consent | 0 |

---

## 2. Signature minimisation

### What the server checks today
- **Mode consent:** a 5-minute window (`packages/shared/src/copy-account-mode-contracts.ts:12`).
- **Agent consent:** ≤10-minute window and ≤30-day validity (`copy-agent-signing.ts:15-16`). The default is 7 days (`copy-agents.tsx:43`, `copy-agent-contracts.ts:3`).
- **Mandate intent:** 5-minute consent window, ≤30-day generation (`copy-live-mandate-contracts.ts:37-40`). The mandate binds IDs that exist only after the agent is approved: `setupId`, `setupRevision`, `authorizationId`/`Version`, `policyFingerprint`, … (`copy-live-mandate.repository.ts:120-126`). Preparation needs an *active*, exchange-approved grant (`:115-119`).
- **Builder consent:** 5 minutes (`copy-live-return.service.ts:96-98`).
- **Return consent:** 5 minutes (`copy-live-return.repository.ts:14`).

### Ordering constraints on the exchange
- **Account mode must come after funding.** `baseline()` requires `role === 'user'` (`copy-account-mode.service.ts:58-61`), and a never-funded account has role `missing`.
- **Account mode must come before the agent.** The absence proof requires `extraAgents` to be empty and spot balances to be zero (`copy-account-mode-evidence.ts:55-60`), and no positions or orders (`:14-16`).
- **The agent and the builder fee need an existing account**, so both also come after funding.
- **Chain:** fund → credit → mode → approveAgent → approveBuilderFee → mandate → activation (`activateFunded`, `copy-live-worker.repository.ts:62-91`).

### Can it collapse?
- **Yes, to one owner consent plus one `UsdSend`.** Steps 4, 5, 6 and 7 become one new EIP-712 `CopyLiveSetupConsent`.
- **Not to a single signature.** The `UsdSend` must be signed by the main wallet's key in Hyperliquid's format, and it can't carry Orbie's terms. Getting to one signature would need a Privy session signer on the *main* wallet, which is a much larger trust change and not recommended.

**Make the consent signable before any exchange step.** The server's `prepare` call does the provider-only work first, none of which needs a consent:
- create the paused strategy (`CopyLiveMandateRepository.create`);
- create the copy wallet (`CopyWalletService.prepare` + reconcile);
- create the agent policy and agent wallet (`CopyAgentService.prepare` / `reconcile` up to state `ready`: `copy-agent.service.ts:88-121`);
- reserve the funding operation (amount = budget).

The challenge then binds: `setupId`, `userId`, `ownerAddress`, `ownerPrivyUserId`, `strategyId`, `leaderAddress`, `sourceNetwork`, `network:'testnet'`, `budgetUsd`, `settingsDigest`, `accountAddress`, `agentAddress`, `agentPolicyId` + fingerprint, `workerQuorumId`, `agentValidUntil`, `accountAbstraction:'disabled'`, `builderAddress` + `builderMaxFeeTenthsBps`, `sweepDestination` (= `ownerAddress`), `masterPolicyFingerprint`, `fundingOperationId` + `fundingNonce` + `amount`, `nonce`, `consentExpiresAt` (5 min, to *submit*), and `setupDeadline` (e.g. +24 h, for the server steps).

**Server-side changes:**
- Replace `verifyAgentOwnerConsent` (`copy-agent.service.ts:149`), the mode consent check (`copy-account-mode.service.ts:~149`), the builder consent (`copy-live-return.service.ts:121`) and `verifyLiveCopyMandateConsent` (`copy-live-mandate.service.ts:73`) with one check: setup row has `consentDigest` (sha256 of the canonical intent; signature verified once at confirm), and the step's exact payload equals the intent's field.
- Each child op stores `setupId` and the consent digest.
- The 5-minute windows still govern *signature acceptance*. Each step's own HL nonce and `request_expiry` stay as today. Unsubmitted steps after `setupDeadline` are abandoned with `setup_expired`; a return is always allowed.
- **Mandate:** keep `LiveCopyMandateIntent` exactly. The server fills it after the grant is active, with a fresh nonce and `consentExpiresAt = nonce + 300000`, and activates it in the same transaction. Add columns `consent_kind ('mandate'|'setup')` and `setup_id`. `consentDigest` = the setup consent digest.
  - Then `mandates()` (`copy-live-worker.repository.ts:34`) and the risk authority, which reads the immutable mandate intent and grant (`postgres-live-risk-authority.ts:50-53`), are unchanged.
- **Stop cancellation:** let `StopCanceller.cancel` (`copy-live-stopper.ts:163-168`) accept, as an alternative to a per-stop consent, the generation's setup consent when the target's cloid is derived from that mandate. Cancellation can't move funds.

### Which steps the worker quorum can sign (instead of the user JWT)
Today, mode, approveAgent, builder and return are signed with the owner's live JWT (`PrivyMasterActionSigner`, `privy-master-signer.ts:51-93`; `copy-agent.service.ts:159`; `privy-account-mode-client.ts`). The JWT is not stored (by design), so these steps stall when the tab closes.

**Recommended design:** at confirm, while the user is online, the API calls `client.wallets().update(masterWalletId, { authorization_context: { user_jwts: [jwt] }, additional_signers: [{ signer_id: PRIVY_AGENT_WORKER_QUORUM_ID, override_policy_ids: [P] }] })`. This exists in `@privy-io/node` 0.35 (`public-api/services/wallets.d.ts:35`).
- `P` is created just before, **user-owned** (`owner: { user_id }`, the same pattern as `privy-agent-provisioner.ts:171-174`), so Orbie can't widen it later without the owner.
- Adding the signer with the owner's own session matches the README requirement "added with the owner's consent" (`README.md:235-241`). The app secret alone could add signers at *creation* (that's what the agent does, `privy-agent-provisioner.ts:200-203`), which is weaker.

**Policy `P` rules**, all `eth_signTypedData_v4` with domain `HyperliquidSignTransaction`/`1`, `chainId` = testnet `signatureChainId`, `verifyingContract` = zero:
1. `HyperliquidTransaction:UsdSend` with `message.destination eq <owner main, lowercase>` and `hyperliquidChain eq "Testnet"`. This is the auto-sweep and idle withdraw.
2. `HyperliquidTransaction:UserSetAbstraction` with abstraction = disabled (types from `UserSetAbstractionTypes`, `privy-account-mode-client.ts:3`).
3. `HyperliquidTransaction:ApproveAgent` with `agentAddress eq A` and `agentName eq "copy{id} valid_until {T}"` (format at `copy-agent-signing.ts:28`).
4. `HyperliquidTransaction:ApproveBuilderFee` with `builder eq B` and `maxFeeRate eq F`. Only if the fee is > 0.
5. DENY `exportPrivateKey` / `exportSeedPhrase` for the signer.

Do **not** set wallet-level `policy_ids` on the copy wallet. The owner's JWT signing and Settings export (`execution-wallets.tsx:113`) must stay unrestricted. Verify on the Stage Dev app that override policies apply only to the additional signer.

With `P` in place, everything after confirm (wait for credit → mode → agent → builder → mandate → activation, plus sweep) runs in the worker with `authorization_private_keys` (the same mechanism as `copy-live-stopper.ts:204-207`).

### Security implications and binding
- **What the worker key can newly do:** (a) move copy-account USDC **only to the owner's main wallet**, (b) set mode to disabled, (c) approve exactly the consented agent and expiry, (d) approve exactly the consented builder fee. None of these is an exfiltration path. Trading authority via the agent already exists, and the phantom-agent policy can't constrain which L1 action is signed (`privy-agent-provisioner.ts:86`).
- **Must check: `agentSendAsset`.** `@nktkas/hyperliquid` 0.33.3 ships `agentSendAsset` (`esm/api/exchange/_methods/agentSendAsset.d.ts`). Hyperliquid's exchange-endpoint doc says "Destination must match the source address", so it's self-transfer only, but add a testnet test proving an agent can't send elsewhere.
  - The SDK also has `agentSetAbstraction`. I couldn't confirm it in HL's docs. If it works, mode could move after the agent, but that needs the absence check relaxed. Not recommended now.
- **How each worker step stays bound to what the owner approved:**
  - It builds its HL payload **from the stored setup intent**, not from mutable rows.
  - It re-asserts current state equals the intent: owner `embeddedWalletAddress`, account address and owner quorum, agent identity and policy fingerprint (`assertSetup`, `copy-agent.service.ts:52-70`), revenue settings.
  - It records `setupId` and digest on the op.
  - Privy enforces the same constants cryptographically, so a server bug or a compromised DB can't redirect funds.
  - The sweep destination is re-checked against `owner.embeddedWalletAddress` at reservation time (`copy-live-return.repository.ts:69`). If the main wallet ever changes, the policy fails closed.
- **Session theft risk:** withdraw-to-main without a signature means a stolen session can only push funds back to the owner. Starting a copy still needs the silent signatures (key access in Privy's iframe), not just the session.

---

## 3. Backend changes (file by file)

### 3a. Orchestration and state machine
**New `packages/shared/src/copy-live-setup-contracts.ts`:**
- `startLiveCopySchema`: `{ idempotencyKey, leader, budgetUsd, settings }`, with `sourceNetwork` defaulting to `mainnet`.
- `liveCopySetupIntentSchema` and `liveCopySetupConsentTypedData` (domain `Copy Trading Setup`, chainId 421614 like the other consents).
- `liveCopySetupSchema` (wire): `{ id, strategyId, stage, issue, consent?, funding?, updatedAt }`.

**Stages:** `provisioning → awaiting_consent → consented → funding_submitted → funded → mode_set → agent_active → builder_ready → running`. Terminal states: `failed`, `expired`, `cancelled`.

**New `apps/api/src/copy/copy-live-setup.service.ts`, `.repository.ts`, `.controller.ts`.** Routes under `me/copy/live`:
- `POST setups` (start): idempotent by key. Runs create strategy → wallet → agent ready → funding reserve. Returns the setup with the challenge (consent intent + funding op).
- `POST setups/:id/confirm` with `{ consentSignature, fundingSignature }` + Bearer:
  - verify the consent;
  - add signer and policy to the master wallet (JWT);
  - claim and submit funding: reuse the `CopyFundingService` broadcast/submit logic (`copy-funding.controller.ts:17-19`);
  - return the setup.
- `GET setups`, `GET setups/:id`: no-store, polled by the dialog and the portfolio.
- `POST setups/:id/cancel`: only before funding is attempted. It cancels the reserved funding.

**Driver:** add `CopyLiveSetupDriver.tick()` to `live-worker/copy-live-engine.ts:60-63`, called before `activateFunded`. Each step:
- reads the child op (`copyFundingOperations`, `copyAccountModeOperations`, `copyAgentSetups`, `copyLiveBuilderApprovals`, `copyLiveMandates`);
- if unknown, it only reconciles, reusing the existing never-resend semantics;
- otherwise it advances one step under `lockCopyUser`.

Crash or closed tab: the setup row is the source of truth, and the driver resumes on the next pass. The web's sessionStorage journals (`lib/copy-live.ts:29`, `lib/copy-funding.ts:34`) are no longer needed for this flow.

**Refactors so steps can run from the worker without the HTTP request:**
- **`copy-account-mode.service.ts`:** extract the "prove → persist attempt → sign → POST" core so it takes a signer strategy (JWT or worker policy). Add a `PrivyPolicyMasterSigner` path to `live/privy-account-mode-client.ts`.
- **`copy-agent.service.ts:140-189`:** do the same for `approve` (signer via `copy-agent-exchange.client.ts`). Default `validForDays` to 30 in setup.
- **`copy-live-return.service.ts`:** split `approveBuilder` and `approve` into `submit(row, signer)`.
- **`copy-live-mandate.repository.ts`:** add `prepareFromSetup(tx, setup)`. It reuses `context()` (`:100-128`) and the builder check (`:147-154`), and calls `activate()` (`:171-184`) with `consent_kind='setup'`.
- **New `live/privy-policy-master-signer.ts`:** a clone of `PrivyMasterActionSigner` (`privy-master-signer.ts:45-93`) using `authorization_context: { authorization_private_keys: [config.copy.agent.authorizationPrivateKey] }`. It also asserts:
  - the wallet's `additional_signers` equals exactly `[{ signer_id: workerQuorumId, override_policy_ids: [account.masterPolicyId] }]`;
  - `masterActionSignable` (`:25-30`), extended to the four allowed types.

### 3b. Privy policy, additional signer and provisioning check
**New `live/privy-master-policy.ts`:**
- `masterPolicyRules(ownerMain, agent, builder)`;
- `createPolicy` / `verifyPolicy`, mirroring `privy-agent-provisioner.ts:164-191` with the `canonical()` fingerprint;
- `attachSigner(walletId, jwt, policyId)` via `wallets().update`.

**`live/privy-wallet-provisioner.ts:54`** currently requires `additional_signers.length === 0`. Change `findOwned(userId, externalId, expected?: { workerQuorumId, policyId })` to accept:
- `[]` when the account row has no `master_policy_id` (legacy and manual accounts), or
- exactly one signer with the expected quorum and override policy, followed by `verifyWorkerQuorum()` (`privy-agent-provisioner.ts:153-162`) and `verifyPolicy`.

Anything else stays `ProvisioningWalletConflict`. The owner quorum check (`:56-60`) is unchanged. Update `copy-wallet.service.ts:66-88` to pass the expectation.

**`copy-account-mode.service.ts`:** unchanged checks. The absence proof only reads `extraAgents` (agents), not Privy signers, so the additional signer doesn't affect it.

### 3c. Auto-sweep after a flat stop
**`live-worker/copy-live-stopper.ts:132-141`:** replace `issue('stop_awaiting_return_to_main_wallet')` with:
- if the account has a master policy:
  - `returns.reserveSystem(stop)`: a new repository method, idempotency key `sweep:${stop.id}`, `stopId` set, amount = withdrawable floored to 6 decimals (as `copy-live-return.service.ts:49-54`);
  - then `begin` → sign with `PrivyPolicyMasterSigner` → `exchange.send` → `finish`;
  - the existing funding monitor confirms the credit, `swept()` (`copy-live-return.repository.ts:111-115`) turns true, and `finish(stop)` runs.
- otherwise keep the manual issue (legacy accounts).

Wire the signer and `CopyFundingExchangeClient` into `copy-live-engine.provider.ts:57-61`.

**Notes:**
- `reserve` refuses when any op is pending for the account (`:77-80`). The system sweep must wait instead of throwing busy.
- `expireStaleReturns` (`:23-27`) must skip system rows, since they have no consent window.

**Idle withdraw:** `copy-live-return.service.ts:45-86`. When a policy signer exists, `approve` can skip the consent signature (make the `consentSignature` optional in `approveCopyMasterActionSchema` only for policy accounts).

### 3d. Mainnet-source leaders
The backend already supports them:
- `create` watches the leader (`copy-live-mandate.repository.ts:85-97`);
- `sourceNetworks: ['mainnet','testnet']` (`copy-live-mandate.service.ts:43`);
- the engine reads the watcher for mainnet (`copy-live-engine.ts:100`).

Only the UI blocks it (`execution-wallets.tsx:33`). In the setup service, default `sourceNetwork` to `mainnet`.

Expect refusals such as `live_source_price_deviation` / `live_market_unknown` (`copy-live-engine.ts:40-41`) where testnet markets diverge. They're already surfaced as `lastRefusal`.

### 3e. Admin preconditions
| Blocker | Location | Proposal | Trade-off |
|---|---|---|---|
| Platform control row never seeded | live requires it (`copy-live-mandate.repository.ts:53-55`, `postgres-live-risk-authority.ts:60`) | Migration inserting `('platform',0,false,false)` ON CONFLICT DO NOTHING | Matches paper semantics, which treats a missing row as clear (`copy.repository.ts:117-125`). Safe. |
| Explicit risk policy row | `copy-live-mandate.repository.ts:35-38`, `postgres-live-risk-authority.ts:56`. Paper uses defaults (`copy-risk-policy.service.ts:49-51`). | Migration inserting version 1 = current `DEFAULT_COPY_RISK_LIMITS` JSON, `reason='seeded defaults'`, `created_by_user_id NULL`, only if the table is empty | Auditable and editable. Freezes today's defaults. Admin can still save a new version. |
| `copyTradingEnabled` default false | `packages/shared/src/schema/zod.ts:1481`. Checked by paper (`copy-strategy.service.ts:130`) and live (`copy-live-mandate.repository.ts:34`, `postgres-live-risk-authority.ts:62`) | Keep as the admin kill switch; set it on Stage in admin | It's the single platform on/off; defaulting true would also open paper. |
| Revenue settings shape | `copy-live-mandate.repository.ts:41-47` returns 503 if a row lacks keys | Parse with schema defaults (`adminSettingsSchema.shape.revenue`) as the risk authority does (`postgres-live-risk-authority.ts:64`) | Removes the inconsistency. Fee 0 means no builder. |

### 3f. Builder fee folded in
- Bind the builder fields in the setup consent.
- The driver step is skipped when the fee is 0. Otherwise it reserves `copyLiveBuilderApprovals` with `setupId`, signs via the policy signer, then `observeBuilder` (`copy-live-return.service.ts:142-149`).
- `prepare`'s `builder_fee_approval_required` (`copy-live-mandate.repository.ts:153`) then never fires in one-click.
- **Risk:** an admin fee change after consent makes every order fail with `live_risk_builder_changed` (`postgres-live-risk-authority.ts:65`). The admin UI should warn, and setups should re-consent.

### 3g. Migrations (next numbers after `0061_settings_env_moved.sql`)
- `0062_copy_platform_control_seed.sql`: platform control row, plus the risk policy v1 if empty.
- `0063_copy_master_signer.sql`, on `copy_execution_accounts`:
  - add `master_policy_id`, `master_policy_fingerprint`, `master_signer_quorum_id`, `sweep_destination`, `signer_attached_at`;
  - add a CHECK that all are null or all are set;
  - widen the issue enum (`packages/shared/src/schema/db.ts:1380-1399`).
- `0064_copy_live_setups.sql`:
  - new table `copy_live_setups`: id uuid, user_id, strategy_id, account_id, idempotency_key unique per user, stage, intent jsonb, intent_digest, consent_digest, consent_expires_at, setup_deadline, the child op ids, issue, revision, attempts, next_attempt_at, timestamps;
  - add `setup_id` / `consent_kind` to `copy_live_mandates`;
  - add `setup_id` to `copy_funding_operations`, `copy_account_mode_operations`, `copy_agent_setups`, `copy_live_builder_approvals`;
  - add `signer_kind ('owner_session'|'worker_policy')` to `copy_funding_operations`.

### 3h. Error codes for the UI
Today many failures are bare `conflict()` (`copy-live-mandate.repository.ts:16`) or plain messages. Give them codes:
- `already_copying` (line 78, same leader)
- `strategy_limit` (line 78)
- `below_min_allocation` / `above_max_allocation` (line 50)
- `leverage_above_limit` (line 79)
- `copy_not_open` (line 34)
- `copy_paused` (line 55)
- `watch_capacity`: exists (line 94)
- `insufficient_main_balance` (`copy-funding.service.ts:77`)
- `funding_pending`: exists (`copy-funding.repository.ts:15`)
- New setup codes: `consent_expired`, `invalid_consent`, `setup_unavailable` (503: provider, worker quorum or mode), `setup_wallet_conflict`, `setup_funding_rejected`, `setup_account_mode_failed` (from `account_mode_absence_unproven` / `baseline_unsupported`), `setup_agent_rejected` (`agent_approval_rejected`), `setup_builder_rejected`, `setup_expired`, `live_stop_in_progress` (exists).

Add them to `packages/shared/src/wire-contracts.ts` and the OpenAPI artifacts.

### 3i. Other blockers to fix in the same work
- **`postgres-live-risk-authority.ts:67` requires ≤8 execution accounts per user *ever*.** It has no state filter, so a one-click user's 9th copy (even after stopping old ones) refuses every order. Filter to accounts with a non-stopped strategy or unswept balance.
- **`:72` refuses all orders while *any* transfer for the user is pending.** Funding copy B or sweeping copy A pauses copy C's legs for seconds. Scope it to the account, or document the delay.

---

## 4. Web changes (file by file)

### Trader page and portfolio
- **`components/trader/copy-panel.tsx`:**
  - Mode pill (§1). Testnet balance from `useWallet()`.
  - Hide or disable the 跟單目前持倉 toggle in testnet mode (`:379-398`).
  - On submit (`:121-165`), testnet calls `useStartLiveCopy` instead of `useStartCopy`, and opens the confirm sheet, then the progress dialog.
  - The existing-copy view (`:200-238`) also covers a testnet copy (badge 測試網 instead of `PaperBadge`).
  - Error mapping gains the codes from §3h.
- **New `lib/copy-live-setup.ts`:**
  - `useStartLiveCopy`: POST setups; then build `liveCopySetupConsentTypedData` + `usdSendTypedData` (`packages/shared/src/copy-funding-signing.ts:5-15`); sign both with the signer; POST confirm. One idempotency key per attempt, kept in a ref.
  - `useLiveCopySetup(id)`: polls every 2 s while it isn't terminal.
- **`lib/wallet-signer.ts` + `lib/auth-privy.tsx:165-168`:** add `signTypedData(data, { silent?: boolean })` that passes `uiOptions: { showWalletUIs: !silent }`. Use silent only after the Orbie confirm sheet.
- **New `components/copy/live-copy-progress.tsx`:** a dialog using the existing modal focus (`lib/use-modal-focus.ts`) with the stage list, retry and "close (continues in background)".
- **`components/copy/live-copies.tsx`:**
  - Replace the Settings links (`:17`, `:112-113`) with 繼續設定 (opens the progress dialog for the setup).
  - Add 暫停/恢復/編輯 (§4 parity below) and 加碼 (silent `UsdSend` via the existing funding path).
  - Withdraw without consent when the account has a policy (`:114-122`).
  - Remove 全部返還主錢包 (`:129-131`) for policy accounts and show 自動返還中 / returned amount. Keep the button only for legacy accounts.
  - Remove the cancellation-consent UI (`:123-128`) once §2's cancellation authority lands.
- **`lib/copy-live-portfolio.ts:36-80`:** drop `transfer` consent signing for policy accounts and add `pause`/`resume`/`edit`.
- **`copy-live-portfolio.repository.ts:44-53` (API):** derive `setup`/`funding`/`awaiting_credit` stages from `copy_live_setups` too, and add `setupId` to `liveCopyPortfolioItemSchema`.

### Settings → /dev
- In `components/settings/settings-view.tsx`, remove `<ExecutionWalletSettings />` at `:276` and `:493`. In Settings, keep only a small read-only "跟單錢包" list with 匯出私鑰 (`execution-wallets.tsx:112-116`) and revoke. CopyDog has an export page.
- New `app/dev/copy/page.tsx` guarded by `labEnabled()` (`lib/dev-lab.ts`, pattern from `app/dev/[[...preview]]/page.tsx:16`) that renders the current `ExecutionWalletSettings`. Static `/dev/copy` takes precedence over the optional catch-all. Fix `execution-wallets.tsx:33` there as well (drop `item.sourceNetwork === 'testnet'`).

### i18n (all 11 locales in `apps/web/src/i18n/messages/*.ts` and `i18n/live-copies.ts`)
- `copyAgents.hint`, zh-TW.ts:213: 「…跟單仍以模擬模式執行」 is false.
- `copyFunding.hint`, :247: 「到帳不會啟動跟單」 is false, because funding triggers activation (`copy-live-worker.repository.ts:62-91`).
- `copyLive.hint`, :63, and `automaticUnavailable`, :67: reword for /dev.
- `live-copies.ts` `hints.setup` / `hints.sweeping` (lines 15/23/31/39/47…): sweeping becomes "funds are returning automatically".
- New `trader.copy.testnet.*` keys: mode labels, confirm sheet, stages, errors.
- `docs/content/faq.*.md:206` ("跟單目前只提供模擬模式") and `:210`: add testnet copy, automatic return, and that the builder cap is part of the one consent (`:220`).

### Edit / pause / resume parity for testnet
- **Pause:** exists (`copy-live-mandate.repository.ts:185-199`). It sets the mandate to `paused` and the strategy to paused + `pauseNewRisk`. The engine leaves legs pending and they expire (`copy-live-engine.ts:151`). No signature.
- **Resume:** missing today. `mandates()` only reads `active` (`copy-live-worker.repository.ts:34`), and `activateFunded` only handles `pending` activations (`:69-70`). Add `POST mandates/:id/resume`: paused → active within the generation's unexpired lifetime, strategy active, `controlRevision` +1, same control checks as `activateFunded`. No signature (the consent already covers the generation).
- **Edit:** paper PATCH refuses testnet (`copy.repository.ts:216`, mode=paper lock). Add `PATCH me/copy/live/strategies/:id`:
  1. new strategy version (settings digest changes);
  2. pause the current mandate;
  3. `prepare` a new generation (the prepare check at `copy-live-mandate.repository.ts:155-159` must allow superseding a `paused` one);
  4. one silent consent;
  5. activation goes through `pending` → `activateFunded` (funding is already credited).

  A budget increase = top-up `UsdSend` + new generation.
- **Renewal:** agent and mandate expire within ≤30 days (`copy-agent-signing.ts:16`, `copy-live-mandate-contracts.ts:39`). Surface "續期" at T-3 days. It's the same edit flow, plus a new agent policy and wallet and approveAgent: one silent signature and a JWT attach of a new rule.

---

## 5. Tests and Stage verification

### API specs (`apps/api/test/`)
- **New `copy-live-setup.spec.ts`** (real Postgres, provider fakes):
  - idempotent start;
  - consent digest mismatch → 403;
  - expired consent;
  - resume after a crash at each stage (unknown funding, unknown mode, `approval_unknown`);
  - `setupDeadline` expiry;
  - never resends an attempted op;
  - mainnet source creates the watch.
- **New `privy-master-policy.spec.ts`:**
  - exact rules and canonical fingerprint;
  - user-owned policy;
  - the `update` request carries only the JWT and the expected signer.
- **New `privy-policy-master-signer.spec.ts`:** modelled on `privy-master-signer.spec.ts`. Refuses foreign `additional_signers`, a different destination, non-allowed primary types, and wallet/owner drift.
- **Extend:**
  - `copy-wallet-provisioner.spec.ts`: legacy empty signers; exact signer + policy; extra signer → conflict.
  - `copy-live-stopper.spec.ts`: flat → system sweep reserved once; legacy → manual issue; dust → finish; a pending op waits.
  - `copy-live-returns.spec.ts`: system reservation, no consent window.
  - `copy-live-mandate-routes.spec.ts`: resume and edit; `consent_kind='setup'` activation.
  - `copy-live-risk-source.spec.ts`: >8 historic accounts no longer blocks.
  - `copy-live-engine.spec.ts`: driver order (setup driver before `activateFunded`).
- **Migration smoke:** `scripts/migration-smoke.mjs` with 0062–0064, and the seed is idempotent.

### Web unit (`apps/web/test/`)
- `copy-panel.test.tsx`: mode pill visibility (`automaticExecution`, privy); testnet balance source; adopt disabled; error-code toasts.
- New `copy-live-setup.test.ts`: two signatures with `showWalletUIs:false`; idempotency key reuse on retry; session change aborts.
- `live-copies.test.tsx`: stages incl. auto-return; buttons per stage; legacy return button.
- `execution-wallets.test.tsx`: moves under /dev, mainnet strategies listed.

### e2e (`apps/web/e2e/`)
- New `testnet-copy.spec.ts` with fixture mode `?signer=fixture` (`lib/fixture-signer.ts`), fixture API states for each stage at 1440/390: panel → confirm → progress → portfolio row → stop → auto-return.
- Update `execution-wallets.spec.ts`: Settings no longer has the forms; `/dev/copy` 404s in production.

### Stage end-to-end with no mainnet funds
Environment: Stage uses the Privy "Dev" app. API and worker both need `COPY_TRADING_MODE=testnet`, `HYPERLIQUID_NETWORK=testnet`, `PRIVY_AGENT_AUTHORIZATION_KEY`/`PRIVY_AGENT_WORKER_QUORUM_ID` (verify with `scripts/copy-worker-key.mjs`), and `HYPERLIQUID_EGRESS_KEY`.

1. Admin: turn `copyTradingEnabled` on. Confirm the seeded platform control row and risk policy v1.
2. Fund the Privy main wallet with mock USDC on HL testnet: `usdSend` from Paul's test wallet (999 mock USDC per `docs/backend-review-2026-10-04.md:35`) via app.hyperliquid-testnet.xyz. The faucet may need mainnet deposit history on the address.
3. Pick an active mainnet trader trading BTC/ETH. Choose 測試網, 100 USDC, confirm. Watch the dialog.
4. Verify on the testnet explorer: `usdSend` main → copy, `userSetAbstraction`, `approveAgent`, (`approveBuilderFee`), first IOC order with an Orbie cloid.
5. Verify via a read-only Privy query that the copy wallet's `additional_signers` = worker + `P`.
6. Close the tab mid-setup, then reopen: the setup completes by itself.
7. Pause, resume, edit (one signature). Stop: reduce-only close → flat → automatic `to_main` (`copy_funding_operations`, `stop_id` set) → credited → stop `stopped`, and the main balance rises.
8. Negative test, with a script extending `scripts/verify-live-worker.mjs`: have the worker key sign a `UsdSend` to another address → Privy denies. Try `agentSendAsset` to another destination → HL rejects.

---

## 6. Risks, open questions, order of work

### Risks
1. **Privy semantics untested here:** whether override policies apply only to the signer; whether `wallets().update` with `user_jwts` can add a signer to a server-created user-owned wallet; typed-data condition matching on the HL string `destination` (exact lowercase). Prototype these on the Stage Dev app first (step 3 below).
2. **Where the credit lands.** If an HL testnet `usdSend` credits spot (unified/default abstraction), the mode step fails its zero-spot check (`copy-account-mode-evidence.ts:58-60`). It worked in the manual flow, presumably, but confirm on Stage.
3. **Testnet vs mainnet prices.** Many legs may be refused for price deviation, and the user sees "running" with no trades.
4. **Per-user transfer lock and 8-account cap** (`postgres-live-risk-authority.ts:67,72`).
5. **Builder change after consent** silently stops trading (`:65`).
6. **Silent signing:** the user doesn't see Privy's payload, so Orbie's confirm sheet carries the whole responsibility for showing the terms.
7. **Copies stop at expiry:** ≤30 days, default 7 today.
8. **Worker key compromise:** the blast radius gains "copy funds back to owner" only, but it's also the key for trading.
9. **Stale docs:** README:120 and gap-audit B1.

### Open questions for Paul
1. OK to sign silently (`showWalletUIs:false`) behind Orbie's own confirm sheet, or keep Privy's modal for the two signatures?
2. Should the worker policy cover only the sweep, or also mode, agent and builder, so setup finishes with the tab closed? Recommended: all four, bound to exact values.
3. Withdraw idle funds to the main wallet without a signature (as CopyDog appears to)?
4. Copy lifetime: accept a 30-day renewal (one signature), or try longer HL agent validity?
5. Seed risk policy v1 from defaults by migration, or require an admin save?
6. Testnet minimum: keep 100 USDC?
7. Builder fee on testnet: keep 0 (step skipped) or set it to exercise the path? The parity doc says the builder address and fee await your confirmation.
8. Existing copy wallets without the signer: keep the manual return, or offer a one-time "enable automatic return" (JWT attach, one signature)?
9. Default mode in the panel: 模擬 or 測試網?
10. Copying current positions (adopt) isn't supported on testnet: hide the toggle, or show it disabled?

### Suggested order of work (commit-sized, rough effort)
1. Docs fixes, i18n false hints, FAQ, and the mainnet filter at `execution-wallets.tsx:33`. **0.5 d**
2. Admin preconditions: migration 0062 (platform row, policy v1), tolerant revenue parse, fix the risk-authority account cap and transfer-lock scope, error codes. **1–1.5 d**
3. Privy master policy + signer attach + `PrivyPolicyMasterSigner` + provisioning check, migration 0063, specs. Prototype on the Stage Dev app first. **2.5–3 d**
4. Auto-sweep in the stopper + system return reservation + idle withdraw without consent + stop cancellation under the generation consent, specs. **1.5–2 d**
5. Shared setup consent contracts + migration 0064 + `CopyLiveSetupService` (start/confirm/get/cancel) + worker driver + refactors of the mode/agent/builder/mandate signers to the strategy pattern, specs. **5–6 d**
6. Live pause/resume/edit/renew endpoints. **1.5–2 d**
7. Web: silent signer option, `lib/copy-live-setup.ts`, panel mode, confirm sheet, progress dialog, unit tests. **3–4 d**
8. Portfolio rows (stages from setups, auto-return state, pause/resume/edit, top-up, withdraw). **1.5–2 d**
9. Move Settings forms to `/dev/copy`; leave the export/revoke list in Settings. **0.5–1 d**
10. e2e fixtures + Stage run and negative policy tests. **1.5–2 d**

**Total: about 19–24 developer-days.** Steps 1–2 unblock the current manual flow immediately. Steps 3–4 alone deliver the automatic return Paul approved.

### Critical files for implementation
- /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/copy-live-mandate.repository.ts
- /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/live/privy-wallet-provisioner.ts (plus the pattern in /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/live/privy-agent-provisioner.ts and /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/live/privy-master-signer.ts)
- /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/live-worker/copy-live-stopper.ts (and /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/api/src/copy/live-worker/copy-live-engine.provider.ts)
- /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/web/src/components/trader/copy-panel.tsx (with /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/web/src/lib/auth-privy.tsx)
- /Users/paul_jiang/Desktop/Paul/Trading-Dashboard/apps/web/src/components/copy/live-copies.tsx

## Decisions (Paul, 2026-10-05: 「照建議」)
1. Sign silently (`showWalletUIs: false`) behind Orbie's own confirm sheet: yes.
2. The worker policy covers all four actions, each bound to exact values: sweep/withdraw `UsdSend` to the owner's main wallet, `UserSetAbstraction` disabled, `ApproveAgent` for the consented agent and expiry, `ApproveBuilderFee` for the consented builder and fee.
3. Idle-fund withdrawal to the main wallet needs no signature: yes.
4. Copy lifetime: 30 days by default, a 續期 prompt at T-3 days, one silent signature to renew.
5. Seed risk policy v1 from the defaults by migration: yes.
6. Testnet minimum stays 100 USDC.
7. Builder fee on testnet stays 0, so the builder step is skipped.
8. Existing copy wallets without the signer keep the manual return.
9. The panel defaults to 模擬.
10. 跟單目前持倉 in 測試網 mode is shown disabled with a note.

Order: admin rebuild (stream 11) first, then steps 1–4 of this plan, then the locale/gradient/chart/skeleton stream, then steps 5–10.

## Prototype results (stream 13, 2026-10-05, Stage Dev Privy app)

Script: `scripts/privy-master-policy-proto.mjs` (credentials read in-process from the Stage api service and the gitignored worker key file, never printed). It uses the production rules (`apps/api/src/copy/live/privy-master-policy.ts`, built `dist`) and asks Privy for signatures only; nothing was posted to Hyperliquid. Last run 08:41Z:

| Check | Result | Evidence |
|---|---|---|
| (a) user-owned policy | **proven** | `policies().create({ owner: { user_id } })` returned a policy whose owner is a user key quorum (5 rules: UsdSend to owner main, UserSetAbstraction disabled for the account, ApproveAgent exact, deny key export, deny seed export). |
| (b) attach with the owner's `user_jwts` | **not run** | The Dev app has no Privy test accounts (`GET /v1/apps/<app>/test_credentials` answers 200 with an empty body), so there is no owner session to sign with. To run it: enable a test account on the Dev app (Privy dashboard → User management → Test accounts) and rerun, or sign in on Stage and run with `PRIVY_PROTO_JWT_FILE=<file holding localStorage privy:token>`. The script then also checks that the app secret alone can't do the same update. |
| (c) override binds only the signer | **not run** | Same: needs the owner's session (it signs a UsdSend to another address and a Withdraw with the owner's JWT, which must succeed). |
| (d) exact lowercase `destination` | **proven** | Worker key: UsdSend to the owner main (lowercase) on Testnet → signed, and the signature recovers to the copy wallet. The same with mixed-case hex → `RPC request denied due to policy violation`. |
| (e) everything else denied for the worker | **proven** | Worker key, each denied by policy: UsdSend to another address; UsdSend with `Mainnet` / chainId 42161; `Withdraw`; ApproveAgent for another agent; `personal_sign`; UserSetAbstraction to `unifiedAccount`, or for another user. Allowed: ApproveAgent for the bound agent and name; UserSetAbstraction `disabled` for the bound account. |

Without an owner session the script attaches the worker at wallet creation with the app secret (as the agent wallets are), which is enough for (d)/(e). (b) and (c) decide whether new copy wallets can get the signer with the owner's consent, so until they are proven no account gets it: the stopper's automatic return (`CopyLiveAutoReturn`), the `PrivyPolicyMasterSigner` and the provisioning check are on `dev` but only act on accounts whose row records a master policy, and nothing writes one yet.

Privy objects created on the Dev app (all labelled `orbie-proto-2026-10-05-…`; server-created users with `@example.invalid` emails, no funds):
- users `did:privy:cmuuznk6501ly0cl88krcm566`, `did:privy:cmuv02oaz01d60cl5e1v9tmo9`, `did:privy:cmuv03o4u00me0bjvycglzbut`;
- policies `yhyp57l2h3xj46c1khwpgxbo`, `q80rnqpd9o7vv90qp9zcfl02`, `ns5jz47b7ub1c5bsst5jk634`;
- wallets `mpkh9sowu5csdq4gimpagdoy` (0xD23f…6aC2), `wgevdgvksfv67er3wwopasqc` (0xbB46…066d), `wsyyb5k9ncm8nsqe0apbttt3` (0x1459…4963).

## Implementation (stream 15, 2026-10-05): steps 5–10

**Flag and fallback.** `COPY_AUTOMATIC_RETURN` decides only who signs the steps after confirm; one-click works either way, and turning it on needs no code change.
- **Off (default until (b)/(c) pass):** start creates no worker policy (`masterPolicyId: ''` in the consent), confirm attaches nothing, the setup's signer is `owner_session`. The worker still confirms the credit and makes the generation; the mode and agent steps are signed with the owner's JWT by `POST /me/copy/live/setups/:id/advance`, which the open progress dialog calls every ~3 s. Closed tab: the setup waits (`awaiting_owner_session`) and resumes from the portfolio's 繼續設定.
- **On:** start creates the owner-owned policy (return, standard mode, exactly the consented agent and name, no export) and the consent binds its id and fingerprint. Confirm attaches the worker as the account's only additional signer with the owner's JWT (`attachSetupSigner`), records it on the account, and the worker's `CopyLiveSetupDriver` (`CopyLiveSetupService.tick`, before `activateFunded`) runs everything with `PrivyPolicyMasterSigner`. If the attach fails, that setup falls back to `owner_session`.

**API.** `POST /me/copy/live/setups` (idempotent start: strategy, wallet, 30-day agent, deposit reservation, challenge), `GET setups[/:id]`, `POST setups/:id/confirm` (consent + deposit signatures, Bearer), `/advance`, `/cancel` (before the deposit is sent), `PATCH strategies/:id` (edit = next generation, one consent), `POST strategies/:id/renew` (T-3 days: new agent + generation; the agent approval is always owner-session signed), `POST mandates/:id/resume` (no signature). Migration 0064: `copy_live_setups`, `live_setup_id` on the child operations, `consent_kind` on generations, `signer_kind` on transfers, one active + one renewing agent per account. A stop cancels a one-click generation's orders under its setup consent.

**Web.** 模擬/測試網 pill on the trader panel (default 模擬, remembered per user), testnet balance from the main wallet, adopt shown disabled with a note, Orbie's confirm sheet listing every term, silent signing (`showWalletUIs: false`) only behind it, the progress dialog, portfolio actions (繼續設定, 暫停/恢復, 編輯設定, 加碼, 續期), Settings' read-only 跟單錢包 (export, revoke), the step-by-step forms at `/[locale]/dev/copy` (lab only).

### Stage verification (Paul, with the 300 testnet USDC on the Stage Orbie wallet)
Prerequisites (main session): deploy api + worker + web; `pnpm db:migrate` runs 0064; api and worker both `COPY_TRADING_MODE=testnet`, `HYPERLIQUID_NETWORK=testnet`, worker key/quorum set; admin `copyTradingEnabled` on. Start with `COPY_AUTOMATIC_RETURN` **unset** (owner-session path).

1. **Owner-session path.** Trader page of an active mainnet BTC/ETH trader → 跟單 panel → 測試網. The balance line shows ~300 (main wallet, testnet). Enter 100 → 開始跟單 → the confirm sheet lists trader, 100 USDC, direction, sizing, testnet, agent expiry (+30 days), builder fee 無, 停止時「自動平倉，返還資金需簽署一次」 → 確認並開始. **No Privy modal should appear** (unless MFA for wallet actions is on). Progress dialog: 準備錢包 ✓ → 入金送出 ✓ → 已入帳 (~5–30 s) → 帳戶設定 → 交易代理授權 → 開始跟單. Keep it open until 跟單已開始.
   - Check on app.hyperliquid-testnet.xyz (copy account address from the portfolio row): `usdSend` main → copy 100, `userSetAbstraction` disabled, `approveAgent` named `copy<id> valid_until <T>`, then the first IOC order with an Orbie cloid when the trader trades.
2. **Resume after closing.** Start a second copy (another trader, 100), and close the dialog right after 入金送出. Portfolio row: 完成設定 + 繼續設定. Wait a minute, click 繼續設定: the dialog continues and finishes.
3. **Pause / resume / edit / top-up.** On the first copy: 暫停 (row → 已暫停, no signature), 恢復 (→ 跟單中), 編輯設定 (change max leverage to 3, budget 100) → confirm sheet → 確認並開始 → finishes at once; 加碼 20 → one silent signature, the transfer shows then disappears once credited.
4. **Stop.** 停止 the first copy: positions close, no cancellation-consent prompt (one-click generation), then 全部返還主錢包 needs one signature (owner-session account).
5. **Owner-session prototype (b)/(c).** Copy `localStorage['privy:token']` from the Stage tab into a file and run `PRIVY_PROTO_JWT_FILE=<file> node scripts/privy-master-policy-proto.mjs` (labelled `orbie-proto-…` objects on the Dev app). Expect `b_attach_with_owner_jwt` and `c_override_binds_only_signer` true, and the app secret alone refused.
6. **Worker-policy path.** If (b)/(c) pass: set `COPY_AUTOMATIC_RETURN=true` on api **and** worker, redeploy, repeat step 1 with a third trader and **close the tab right after confirming**. Reopen the portfolio a minute later: 跟單中 without having come back; the confirm sheet said 「自動平倉，資金自動返還主錢包」, the row shows 自動返還 on Settings' 跟單錢包.
7. **Negative policy tests on that real wallet.** `COPY_WALLET_ID=<privy_wallet_id> OWNER_MAIN=<sweep_destination> node scripts/verify-copy-wallet-policy.mjs` (values from `select privy_wallet_id, sweep_destination from copy_execution_accounts where master_policy_id is not null`). Expect `signers`, `allow_return` true and every `deny_*` denied. Then stop that copy: positions close, 自動返還中, then 已停止 with 「已返還 X USDC 至主錢包」 and the main balance up, without any signature.
8. **agentSendAsset (plan §2).** On app.hyperliquid-testnet.xyz this needs the agent's key, which only Privy holds: leave it for a scripted check with the worker key (open item).
