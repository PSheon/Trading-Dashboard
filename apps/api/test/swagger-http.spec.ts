import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import request from "supertest";
import { documentationControllers } from "../src/bootstrap/documentation-controllers.js";
import { setupSwagger } from "../src/bootstrap/swagger.js";
import { configureHttpSecurity } from "../src/common/http/security.js";
import { validateEnvironment } from "../src/config/runtime-config.js";

it.each(["development", "test", "staging", "production"])("serves Swagger only in local environments: %s", async nodeEnv => {
  const module = await Test.createTestingModule({ controllers: documentationControllers }).useMocker(() => ({})).compile();
  const app = module.createNestApplication({ logger: false });
  configureHttpSecurity(app, validateEnvironment({ NODE_ENV: nodeEnv, DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test" }));
  setupSwagger(app, nodeEnv);
  await app.listen(0, "127.0.0.1");
  try {
    const enabled = nodeEnv === "development" || nodeEnv === "test";
    const html = await request(app.getHttpServer()).get("/docs/").expect(enabled ? 200 : 404);
    const json = await request(app.getHttpServer()).get("/docs-json").expect(enabled ? 200 : 404);
    await request(app.getHttpServer()).get("/docs/swagger-ui-init.js").expect(enabled ? 200 : 404);
    if (enabled) {
      expect(html.text).toContain("swagger-ui");
      expect(html.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(json.body.openapi).toBe("3.1.0");
      expect(json.body).not.toHaveProperty("success");
      expect(json.body.components.schemas.PatchMeDto.properties.locale.enum).toEqual(["en", "zh-TW", "zh-CN", "ko", "ja", "ru", "tr", "vi", "es", "pt", "id"]);
    } else {
      expect(html.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    const other = await request(app.getHttpServer()).get("/docs-evil").expect(404);
    expect(other.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  } finally { await app.close(); }
});
