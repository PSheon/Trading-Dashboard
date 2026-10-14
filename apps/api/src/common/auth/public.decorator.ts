import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Open to anonymous callers; a valid token still attaches the caller, an invalid one is ignored. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
