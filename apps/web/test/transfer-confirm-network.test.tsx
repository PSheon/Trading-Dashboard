// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TransferConfirm } from '@/components/copy/transfer-confirm';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));

// The confirm sheet before a return or a withdrawal names the
// copy's network. On the mainnet Stage it said 「Hyperliquid 測試網」 for a
// real-money copy.
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function sheet(network: 'testnet' | 'mainnet') {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}>
    <TransferConfirm kind="returnAll" open amount="全部（約 49.00 USDC）" destination={`0x${'11'.repeat(20)}`} network={network} pending={false} error={null} onConfirm={() => {}} onOpenChange={() => {}} />
  </I18nProvider>));
  return document.body.textContent ?? '';
}
it('says mainnet and real funds for a mainnet copy, and testnet for a testnet one', async () => {
  const mainnet = await sheet('mainnet');
  expect(mainnet).toContain('Hyperliquid 主網（真實資金）');
  expect(mainnet).not.toContain('測試網');
  expect(await sheet('testnet')).toContain('Hyperliquid 測試網');
});
