// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveCopySetupIntentSchema, type LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { LiveCopyConfirm } from '@/components/copy/live-copy-setup-dialogs';
import { shareName } from '@/lib/share-card';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner', wallet: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/trader', useSearchParams: () => new URLSearchParams() }));

const now = Date.now();
const leader = '0xe066aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa78da';
const consent = liveCopySetupIntentSchema.parse({ kind: 'start', setupId: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', userId: 1, ownerAddress: `0x${'11'.repeat(20)}`, ownerPrivyUserId: 'did:privy:owner',
  strategyId: 7, leaderAddress: leader, sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '150', settingsDigest: 'a'.repeat(64), accountId: 'acct', accountAddress: `0x${'22'.repeat(20)}`,
  accountAbstraction: 'disabled', agentAddress: `0x${'33'.repeat(20)}`, agentPolicyId: 'policy', agentPolicyFingerprint: 'b'.repeat(64), workerQuorumId: 'worker', agentValidUntil: now + 30 * 86_400_000,
  builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: `0x${'11'.repeat(20)}`, masterPolicyId: 'master', masterPolicyFingerprint: 'c'.repeat(64),
  fundingOperationId: '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f', fundingNonce: now - 10, fundingAmount: '150', nonce: now, consentExpiresAt: now + 300_000, setupDeadline: now + 86_400_000 });
const setup: LiveCopySetup = { id: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', kind: 'start', strategyId: 7, accountId: 'acct', leaderAddress: leader, sourceNetwork: 'mainnet', budgetUsd: '150',
  settings: { direction: 'same', sizingMode: 'ratio', perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' }, stage: 'awaiting_consent', issue: null,
  consent, funding: null, mandateId: null, setupDeadline: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };

let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ''; });

async function traderLine(traderName: string | undefined) {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}>
    <LiveCopyConfirm setup={setup} traderName={traderName} open onOpenChange={() => {}} onConfirm={() => {}} pending={false} error={null} />
  </I18nProvider>));
  const terms = document.querySelector('[data-testid="live-copy-terms"]')!;
  return terms.querySelector('dd')!.textContent;
}

it('shows a trader with no name once: the page passes the short address as the name', async () => {
  expect(await traderLine(shareName({ address: leader }))).toBe('0xe066…78da');
});

it('keeps a real name beside the short address', async () => {
  expect(await traderLine('solanadoomer')).toBe('solanadoomer · 0xe066…78da');
});
