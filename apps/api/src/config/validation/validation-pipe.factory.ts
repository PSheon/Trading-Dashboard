import { BadRequestException, ValidationPipe, type ArgumentMetadata } from "@nestjs/common";
import type { ValidationError } from "class-validator";

function fields(errors: ValidationError[], prefix = ""): { path: string; message: string }[] {
  return errors.flatMap(error => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    return [...Object.values(error.constraints ?? {}).map(message => ({ path, message })), ...fields(error.children ?? [], path)];
  });
}
/** Native ValidationPipe accepts some primitive/empty-array optional DTOs.
 * Enforce the JSON object boundary before class transformation can erase shape. */
class RequestValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata) {
    if (this.toValidate(metadata) && value !== undefined &&
        (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new BadRequestException({ statusCode: 400, code: "validation_error", message: "Invalid request",
        issues: [{ path: metadata.data ?? "", message: "Expected an object" }] });
    }
    return super.transform(value, metadata);
  }
}

/** Shared by the production APP_PIPE and HTTP test modules. No implicit boolean conversion. */
export function createValidationPipe(): ValidationPipe {
  return new RequestValidationPipe({
    transform: true,
    validateCustomDecorators: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: errors => new BadRequestException({ statusCode: 400, code: "validation_error", message: "Invalid request", issues: fields(errors) }),
  });
}
