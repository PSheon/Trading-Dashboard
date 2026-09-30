import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi } from "./openapi.mjs";
import { httpRouteContracts } from "../packages/shared/dist/wire-contracts.js";
test("documents all runtime responses, raw probes, no-content and SSE exceptions", async () => {
  const doc = await buildOpenApi();
  assert.equal(Object.values(doc.paths).reduce((n, methods) => n + Object.keys(methods).length, 0), httpRouteContracts.length);
  const actions = doc.paths["/actions"].get.responses[200].content["application/json"].schema;
  assert.ok(actions.required.includes("data"));
  assert.equal(actions.properties.data.items.properties.id.type, "string");
  assert.ok(doc.components.schemas.ResponseMeta.required.includes("timestamp"));
  assert.equal(doc.paths["/health/ready"].get.responses[200].content["application/json"].schema.properties.ready.const, true);
  assert.equal(doc.paths["/me/telegram"].delete.responses[204].content, undefined);
  assert.deepEqual(Object.keys(doc.paths["/actions/stream"].get.responses[200]["x-event-schemas"]).sort(), ["action", "reset", "update"]);
});

test("includes native request body schemas and query/path/header parameters", async () => {
  const doc = await buildOpenApi();
  assert.equal(doc.paths["/me"].patch.requestBody.content["application/json"].schema.$ref, "#/components/schemas/PatchMeDto");
  assert.ok(doc.paths["/traders"].get.parameters.some(p => p.name === "limit" && p.schema.default === 50));
  assert.ok(doc.paths["/traders/{address}"].get.parameters.some(p => p.name === "address" && p.required));
  assert.ok(doc.paths["/actions/stream"].get.parameters.some(p => p.name === "Last-Event-ID" && p.in === "header"));
  assert.deepEqual(doc.paths["/admin/settings"].patch["x-required-permissions"], ["settings.write"]);
});

test("the complete native document is valid OpenAPI with resolvable local references", async () => {
  const { default: SwaggerParser } = await import("@apidevtools/swagger-parser");
  const doc = await buildOpenApi();
  await SwaggerParser.validate(doc, { resolve: { external: false } });
});

test("preserves positional chart tuples using the OpenAPI 3.1 JSON Schema dialect", async () => {
  const doc = await buildOpenApi();
  assert.equal(doc.openapi, "3.1.0");
  const tuple = doc.paths["/traders/{address}/portfolio"].get.responses[200].content["application/json"].schema.properties.data.properties.accountValue.items;
  assert.equal(tuple.type, "array");
  assert.deepEqual(tuple.prefixItems.map(item => item.type), ["number", "number"]);
  assert.equal(tuple.items, false);
});
