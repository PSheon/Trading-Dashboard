import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { TradersController } from "../src/traders/traders.controller.js";
import { MeController } from "../src/users/me.controller.js";
import { AdminController } from "../src/admin/admin.controller.js";

let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [TradersController, MeController, AdminController] })
    .useMocker(() => ({})).compile();
  app = module.createNestApplication({ logger: false });
});
afterAll(async () => { await app?.close(); });
it("discovers native request DTO properties, bounds, nullability and nesting", () => {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("test").setVersion("1").build());
  const query = doc.paths["/traders"].get!.parameters as { name: string; required: boolean; schema: SchemaObject }[];
  expect(query.find(p => p.name === "limit")).toMatchObject({ required: false, schema: { minimum: 1, maximum: 100, default: 50 } });
  expect(query.find(p => p.name === "hideVaults")).toMatchObject({ schema: { type: "string", enum: ["true", "false"] } });
  const profile = doc.components!.schemas!.PatchMeDto as SchemaObject;
  expect(profile.properties!.displayName).toMatchObject({ type: "string", nullable: true, maxLength: 64 });
  const settings = doc.components!.schemas!.PatchAdminSettingsDto as SchemaObject;
  expect(settings.properties!.general).toBeDefined();
  expect(settings.properties!.expectedRevisions).toBeDefined();
});

it("exports every route with native input metadata, wire responses and real authorization metadata", async () => {
  const { buildOpenApiDocument } = await import("../src/bootstrap/swagger.js");
  const { documentationControllers } = await import("../src/bootstrap/documentation-controllers.js");
  const module = await Test.createTestingModule({ controllers: documentationControllers }).useMocker(() => ({})).compile();
  const full = module.createNestApplication({ logger: false });
  try {
    const doc = buildOpenApiDocument(full);
    const { httpRouteContracts } = await import("@trading-dashboard/shared/contracts");
    expect(Object.values(doc.paths).reduce((n, path) => n + Object.keys(path!).length, 0)).toBe(httpRouteContracts.length);
    expect(doc.paths["/admin/settings"].patch!.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/admin/settings"].patch!).toMatchObject({ "x-required-permissions": ["settings.write", "admin.access"] });
    expect(doc.paths["/traders"].get!.security).toEqual([{}, { bearerAuth: [] }]);
    expect(doc.paths["/actions/stream"].get!.parameters).toContainEqual(expect.objectContaining({ name: "Last-Event-ID", in: "header" }));
    const query = doc.paths["/traders/sparklines"].get!.parameters as { name: string; schema: SchemaObject }[];
    expect(query.find(p => p.name === "addresses")!.schema.type).toBe("string");
    const settings = doc.components!.schemas!.PatchAdminSettingsDto as SchemaObject;
    expect(settings.additionalProperties).toBe(false);
    expect(settings.minProperties).toBe(1);
    expect(doc.paths["/actions"].get!.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { properties: { success: { enum: [true] }, data: { type: "array" } } } } },
    });
    expect(doc.paths["/me/telegram"].delete!.responses["204"]).not.toHaveProperty("content");
    expect(doc.paths["/health/ready"].get!.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { properties: { ready: { const: true } } } } },
    });
  } finally { await full.close(); }
});
