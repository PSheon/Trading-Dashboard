import type { KeyboardEvent } from 'react';

/** Arrow navigation for sibling tabs/radios; native buttons retain Enter/Space. */
export function rovingFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const role = event.currentTarget.getAttribute('role');
  const keys = role === 'radio' ? ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] : ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(`button[role="${role}"]:not(:disabled)`) ?? []);
  const index = buttons.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
  buttons[next]?.click();
}
