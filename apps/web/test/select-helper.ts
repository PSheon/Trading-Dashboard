import { act } from "react";

/** Browser APIs Radix Select needs that happy-dom / jsdom lack. */
export function installSelectDom() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  if (!("ResizeObserver" in globalThis)) {
    Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  }
}

const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

/** Opens a shared Select with the keyboard (Enter on its trigger) and picks
 * the option whose value is `value` (Enter on it), as a keyboard user does. */
export async function chooseOption(trigger: Element | null, value: string) {
  if (!trigger) throw new Error("No select trigger");
  installSelectDom();
  await act(async () => {
    (trigger as HTMLElement).focus();
    key(trigger, "Enter");
  });
  const item = document.querySelector(`[data-slot="select-content"] [data-value="${CSS.escape(value)}"]`);
  if (!item) throw new Error(`No option ${value}`);
  await act(async () => {
    (item as HTMLElement).focus();
    key(item, "Enter");
  });
}

/** The trigger of the first shared Select inside `root`. */
export const selectTrigger = (root: ParentNode, index = 0) => root.querySelectorAll<HTMLButtonElement>('[data-slot="select-trigger"]')[index] ?? null;

/** The options a shared Select offers (opens it, reads them, closes it with
 * Escape). */
export async function selectOptions(trigger: Element | null): Promise<{ value: string; text: string }[]> {
  if (!trigger) return [];
  installSelectDom();
  await act(async () => {
    (trigger as HTMLElement).focus();
    key(trigger, "Enter");
  });
  const items = [...document.querySelectorAll('[data-slot="select-content"] [data-value]')].map((el) => ({ value: el.getAttribute("data-value")!, text: el.textContent ?? "" }));
  const content = document.querySelector('[data-slot="select-content"]');
  await act(async () => {
    if (content) key(content, "Escape");
  });
  return items;
}
