// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from '@/components/ui/dialog';
import { Drawer } from '@/components/ui/drawer';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { I18nProvider } from '@/i18n/provider';
import { en } from '@/i18n/messages/en';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  const html = document.createElement('html'); html.append(document.createElement('head'), document.createElement('body'));
  document.replaceChildren(html);
});
const tick = () => act(async () => new Promise(resolve => setTimeout(resolve, 1)));
async function pointer(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.focus();
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await tick();
}
it.each([{ name: 'modal', Panel: Modal }, { name: 'drawer', Panel: Drawer }])('the document hydration root keeps $name open when a notification pointer reaches document listeners', async ({ Panel }) => {
  const changed = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(false), toast = useToast();
    return <><button onClick={() => setOpen(true)}>deposit</button><Panel open={open} title="Deposit" onOpenChange={value => { changed(value); setOpen(value); }}>
      <button onClick={() => toast.success('Address copied', { autoClose: false })}>copy</button>
    </Panel></>;
  }
  // Next hydrates document. React and Radix both listen on that same node:
  // native stopPropagation does not stop the next listener on document.
  root = createRoot(document);
  // eslint-disable-next-line @next/next/no-head-element -- This regression renders a document root, not a Next page.
  await act(async () => root!.render(<html><head /><body><I18nProvider locale="en" messages={en}><ToastProvider><Fixture /></ToastProvider></I18nProvider></body></html>));
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click()); await tick();
  const copy = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button => button.textContent === 'copy')!;
  await act(async () => copy.click()); await tick();
  const notice = document.querySelector<HTMLElement>('[role=status]')!;
  const close = notice.querySelector<HTMLButtonElement>('button[aria-label=Close]')!;
  await pointer(close);
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Deposit');
  expect(changed).not.toHaveBeenCalledWith(false);
  await act(async () => new Promise(resolve => setTimeout(resolve, 260)));
  expect(document.querySelector('[data-sonner-toast]')).toBeNull();
  expect(document.querySelector('[role=dialog]')!.contains(document.activeElement)).toBe(true);
  const backdrop = document.querySelector<HTMLElement>('div[data-state=open].bg-overlay')!;
  await pointer(backdrop);
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(changed).toHaveBeenCalledWith(false);
  await pointer(document.querySelector<HTMLButtonElement>('button')!);
  expect(document.querySelector('[role=dialog]')).toBeTruthy();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
