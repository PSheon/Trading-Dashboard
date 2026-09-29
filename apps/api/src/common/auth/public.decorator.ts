import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Marks a route as exempt from the global bearer-token guard.
 * Used on the `/health` route per §8 (auth applies everywhere else).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
