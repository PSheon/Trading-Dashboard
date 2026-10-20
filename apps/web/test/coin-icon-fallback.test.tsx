// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { CoinIcon } from '@/components/traders/coin-icon';

const proto = HTMLImageElement.prototype;
const restore: (() => void)[] = [];
function imageState(complete: boolean, naturalWidth: number) {
  for (const [key, value] of [['complete', complete], ['naturalWidth', naturalWidth]] as const) {
    const before = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, get: () => value });
    restore.push(() => { if (before) Object.defineProperty(proto, key, before); else delete (proto as unknown as Record<string, unknown>)[key]; });
  }
}
afterEach(() => { while (restore.length) restore.pop()!(); document.body.innerHTML = ''; });
async function render() {
  const container = document.createElement('div'); document.body.append(container);
  await act(async () => { createRoot(container).render(<CoinIcon coin="BTC" size={20} />); });
  return container;
}

it('draws the glyph for an icon that already failed before its error handler was attached (Stage 2026-10-18)', async () => {
  imageState(true, 0);
  const container = await render();
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toBe('₿');
});

it('keeps the icon while it loads, or once it loaded', async () => {
  imageState(false, 0);
  expect((await render()).querySelector('img')).not.toBeNull();
  restore.pop()!(); restore.pop()!(); imageState(true, 20);
  expect((await render()).querySelector('img')).not.toBeNull();
});
