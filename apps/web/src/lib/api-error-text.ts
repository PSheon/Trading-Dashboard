import type { MessageKey } from "@/i18n/messages";

/**
 * What to tell the user when an api call failed and no message of its own
 * applies. The api's `message` is English text written for logs and
 * developers ("Too Many Requests", validation paths): it is never shown.
 */
export function apiErrorKey(error: { status?: number } | null | undefined): MessageKey {
  const status = error?.status;
  if (status === 429) return "common.errors.rateLimited";
  if (status === 502 || status === 503 || status === 504) return "common.errors.busy";
  return "common.errors.failed";
}
