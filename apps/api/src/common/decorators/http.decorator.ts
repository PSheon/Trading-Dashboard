import { ApiOperation } from "@nestjs/swagger";
import { SetMetadata } from "@nestjs/common";
export const SKIP_TRANSFORM_KEY = "http:skip-transform";
export const RESPONSE_MESSAGE_KEY = "http:response-message";
/** Explicit raw response boundary (health, provider protocols, SSE). Not an auth bypass. */
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM_KEY, true);
/** Human-readable success message. HTTP status, auth and response schema stay independent. */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);

/** Documentation only. Public/permissions/roles remain explicit auth decorators. */
export const ApiDoc = (summary: string, description?: string) => ApiOperation({ summary, description });
