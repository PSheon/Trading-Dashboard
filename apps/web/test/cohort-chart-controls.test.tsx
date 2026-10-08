// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PositioningChart } from '@/components/insights/positioning-chart';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import type { CohortWindow } from '@/lib/contracts';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

it('changes the cohort chart period with one named keyboard tab stop', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function Chart() {
    const [window, setWindow] = useState<CohortWindow>('7d');
    return <I18nProvider locale="en" messages={catalogs.en}><PositioningChart title="Positioning" series={[]} btc={[]} window={window} onWindow={setWindow} /><output>{window}</output></I18nProvider>;
  }
  try {
    await act(async () => root.render(<Chart />));
    const group = container.querySelector('[role="radiogroup"][aria-label="Positioning"]')!;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.filter(button => button.tabIndex === 0)).toHaveLength(1);
    const key = (button: HTMLElement, value: string) => act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
    radios[0]!.focus(); await key(radios[0]!, 'ArrowRight');
    expect(container.querySelector('output')!.textContent).toBe('30d');
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    await key(radios[1]!, 'End');
    expect(container.querySelector('output')!.textContent).toBe('all');
    await key(radios[3]!, 'Home');
    expect(container.querySelector('output')!.textContent).toBe('7d');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
