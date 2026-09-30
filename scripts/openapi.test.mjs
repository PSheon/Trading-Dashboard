import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi } from "./openapi.mjs";
import { httpRouteContracts } from "../packages/shared/dist/wire-contracts.js";
test("documents all runtime responses, raw probes, no-content and SSE exceptions", () => {
  const doc = buildOpenApi();
  assert.equal(Object.values(doc.paths).reduce((n, methods) => n + Object.keys(methods).length, 0), httpRouteContracts.length);
  const actions = doc.paths["/actions"].get.responses[200].content["application/json"].schema;
  assert.ok(actions.required.includes("data"));
  assert.equal(actions.properties.data.items.properties.id.type, "string");
  assert.ok(doc.components.schemas.ResponseMeta.required.includes("timestamp"));
  assert.equal(doc.paths["/health/ready"].get.responses[200].content["application/json"].schema.properties.ready.enum[0], true);
  assert.equal(doc.paths["/me/telegram"].delete.responses[204].content, undefined);
  assert.deepEqual(Object.keys(doc.paths["/actions/stream"].get.responses[200]["x-event-schemas"]).sort(), ["action", "reset", "update"]);
});
