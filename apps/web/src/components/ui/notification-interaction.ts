/** Radix's outside-pointer event carries the native target. A notification
 * rendered by the app's own toaster is an overlay control, not the backdrop. */
export function keepPanelOpenForNotification(event: { detail: { originalEvent: PointerEvent }; preventDefault(): void }) {
  const target = event.detail.originalEvent.target;
  if (target instanceof Element && target.closest('[data-app-toaster] [data-sonner-toast]')) event.preventDefault();
}
