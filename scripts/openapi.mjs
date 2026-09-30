import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { httpRouteContracts } from "../packages/shared/dist/wire-contracts.js";
import { responseMetaSchema, errorEnvelopeSchema } from "../packages/shared/dist/http-contract.js";

// The runtime remains on Zod 3; this build-time adapter converts its actual
// output allowlists. Do not infer documentation from persistence models.
const schema = (value) => zodToJsonSchema(value, { target: "openApi3", $refStrategy: "none" });
export function buildOpenApi() {
  const paths = {};
  for (const route of httpRouteContracts) {
    const path = route.path.replace(/:([^/]+)/g, "{$1}");
    const response = route.status === 204 ? { description: "No content" }
      : route.stream ? { description: "Server-sent events; errors before stream establishment use ErrorEnvelope.",
        content: { "text/event-stream": { schema: { type: "string" } } },
        "x-event-schemas": Object.fromEntries(Object.entries(route.stream.events).map(([name, value]) => [name, schema(value)])) }
      : { description: "Success", content: { "application/json": { schema: route.raw ? schema(route.response) : {
        type: "object", required: ["success", "statusCode", "message", "data", "meta"],
        properties: { success: { type: "boolean", enum: [true] }, statusCode: { type: "integer", enum: [route.status] },
          message: { type: "string" }, data: schema(route.response), meta: { $ref: "#/components/schemas/ResponseMeta" } },
      } } } };
    const parameters = [...route.path.matchAll(/:([^/]+)/g)].map(([, name]) => ({
      name, in: "path", required: true, schema: { type: "string" },
    }));
    const operation = { operationId: route.method.toLowerCase() + route.path.replace(/[^a-zA-Z0-9]/g, "_"),
      description: "Access: " + route.auth, security: route.auth.startsWith("public") ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }],
      parameters, responses: { [route.status]: response,
        default: { description: route.raw ? "Operational error (raw)" : "HTTP error; statusCode matches the HTTP status.",
          content: { "application/json": { schema: route.raw ? { type: "object" } : { $ref: "#/components/schemas/ErrorEnvelope" } } } } } };
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return { openapi: "3.0.3", info: { title: "Trading Dashboard HTTP responses", version: "1",
    description: "Response contract reference. Request DTO constraints remain documented in source; this artifact is not yet a complete request/client-generation specification." },
    paths, components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Privy access token, or a scoped service token where permitted." } },
      schemas: { ResponseMeta: schema(responseMetaSchema), ErrorEnvelope: schema(errorEnvelopeSchema) } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL("../docs/openapi-responses.json", import.meta.url);
  const document = JSON.stringify(buildOpenApi(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== document) throw new Error("OpenAPI response contracts are stale");
  } else writeFileSync(target, document);
}
