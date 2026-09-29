import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Open to anonymous callers (market data, health). A valid token still
 * attaches the caller, so `@CurrentUser()` works for personalisation; an
 * invalid one is ignored.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
