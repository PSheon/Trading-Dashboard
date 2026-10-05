import { swaggerEnabled } from "./swagger-policy.js";
import type { INestApplication } from "@nestjs/common";
import { MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject, type OperationObject, type ResponseObject, type SchemaObject } from "@nestjs/swagger";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { httpRouteContracts, responseMetaSchema, errorEnvelopeSchema } from "@trading-dashboard/shared/contracts";
import { IS_PUBLIC_KEY } from "../common/auth/public.decorator.js";
import { requiredPermissions } from "../common/auth/permissions.js";
import { ROLES_KEY } from "../common/auth/current-user.js";

export const SWAGGER_PATH = "docs";
/** Zod 3 exports draft-07 tuples; OAS 3.1 uses JSON Schema 2020-12. */
function to2020(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(to2020);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema")
    .map(([key, child]) => [key, to2020(child)]));
  if (result.type === "array" && Array.isArray(result.items)) {
    result.prefixItems = result.items;
    result.items = result.additionalItems ?? false;
    delete result.additionalItems;
  }
  return result;
}
const schema = (value: ZodTypeAny): SchemaObject =>
  to2020(zodToJsonSchema(value, { target: "jsonSchema7", $refStrategy: "none" })) as SchemaObject;

/** Same source for live Swagger, the offline artifact and contract tests. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder().setOpenAPIVersion("3.1.0").setTitle("Trading Dashboard API").setVersion("1")
    .setDescription("Native Nest request DTOs and validated JSON wire responses. Unknown DTO keys are rejected. " +
      "Query numbers are serialized as strings; empty numeric values are rejected except the documented fills limit fallback. " +
      "Conditional business constraints (settings revisions, rule parameters and import column semantics) are described on their inputs. " +
      "Privy bearer tokens identify users; server-owned roles and permissions authorize access. " +
      "Public favorites queries require a human user. Service tokens cannot act as an owned profile.")
    .addBearerAuth({ type: "http", scheme: "bearer", description: "Privy access token, or scoped service token where permitted." }, "bearerAuth")
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controller, method) => controller + "_" + method,
  });
  const reflector = new Reflector();
  const targets = new Map<string, [Function, Function]>();
  const scanner = new MetadataScanner();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (!controller?.prototype) continue;
      for (const method of scanner.getAllMethodNames(controller.prototype)) {
        targets.set(controller.name + "_" + method, [controller.prototype[method], controller]);
      }
    }
  }
  const schemas = document.components!.schemas ??= {};
  for (const model of Object.values(schemas)) {
    if ("properties" in model && model.properties) model.additionalProperties = false;
  }
  // These DTOs have service-level non-empty section semantics in addition to
  // native field validation. Keep dynamic maps explicitly extensible.
  for (const name of ["GeneralPatchDto", "DiscoveryPatchDto", "NotificationsPatchDto", "RevenuePatchDto"]) {
    if (schemas[name]) (schemas[name] as SchemaObject).minProperties = 1;
  }
  if (schemas.PatchAdminSettingsDto) {
    Object.assign(schemas.PatchAdminSettingsDto, { minProperties: 1,
      anyOf: ["general", "discovery", "notifications", "revenue"].map(name => ({ required: [name] })) });
  }
  schemas.ResponseMeta = schema(responseMetaSchema);
  schemas.ErrorEnvelope = schema(errorEnvelopeSchema);
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, value] of Object.entries(item ?? {})) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      const operation = value as OperationObject & { [key: `x-${string}`]: unknown };
      const contract = httpRouteContracts.find(route => route.method.toLowerCase() === method &&
        route.path.replace(/:([^/]+)/g, "{$1}") === path);
      if (!contract) throw new Error("Missing response contract for " + method + " " + path);
      if (!operation.responses?.[String(contract.status)]) throw new Error("HTTP status differs from contract: " + method + " " + path);
      seen.add(contract.method + " " + contract.path);
      const routeTargets = targets.get(operation.operationId!);
      if (!routeTargets) throw new Error("Missing route metadata for " + operation.operationId);
      const permissions = requiredPermissions(reflector, routeTargets);
      const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, routeTargets) ?? [];
      const publicRoute = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, routeTargets) && !permissions.length && !roles.length;
      operation.security = publicRoute ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }];
      operation["x-required-permissions"] = permissions;
      operation["x-required-roles"] = roles;
      operation.description = [operation.description, "Access: " + contract.auth, contract.errors?.length ? "Error codes: " + contract.errors.join(", ") : ""].filter(Boolean).join("\n\n");
      if (contract.errors?.length) operation["x-error-codes"] = [...contract.errors];
      const success: ResponseObject & { "x-event-schemas"?: Record<string, SchemaObject> } = contract.status === 204 ? { description: "No content" }
        : contract.stream ? { description: "Server-sent events. Errors before admission use the JSON error envelope.",
          content: { "text/event-stream": { schema: { type: "string" } } },
          "x-event-schemas": Object.fromEntries(Object.entries(contract.stream.events).map(([name, value]) => [name, schema(value)])) }
        : contract.binary ? { description: "Image bytes",
          content: Object.fromEntries(contract.binary.contentTypes.map((type) => [type, { schema: { type: "string", format: "binary" } }])) }
        : { description: "Success", content: { "application/json": { schema: contract.raw ? schema(contract.response) : {
          type: "object", required: ["success", "statusCode", "message", "data", "meta"],
          properties: { success: { type: "boolean", enum: [true] }, statusCode: { type: "integer", enum: [contract.status] },
            message: { type: "string" }, data: schema(contract.response), meta: { $ref: "#/components/schemas/ResponseMeta" } },
        } } } };
      operation.responses = { [contract.status]: success, default: {
        description: contract.raw ? "Raw operational error" : "HTTP error. statusCode equals the HTTP status; stable codes/details and dotted validation fields.",
        content: { "application/json": { schema: contract.raw ? { type: "object" } : { $ref: "#/components/schemas/ErrorEnvelope" } } },
      } };
    }
  }
  if (seen.size !== httpRouteContracts.length) throw new Error("OpenAPI controller coverage is incomplete");
  return document;
}

/** Mounted only in development/test; authorization for API operations is unchanged. */
export function setupSwagger(app: INestApplication, nodeEnv: string): void {
  if (!swaggerEnabled(nodeEnv)) return;
  SwaggerModule.setup(SWAGGER_PATH, app, buildOpenApiDocument(app), {
    jsonDocumentUrl: "docs-json",
    raw: ["json"],
    swaggerOptions: { persistAuthorization: false, validatorUrl: null },
  });
}
