import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { documentationControllers } from "../dist/bootstrap/documentation-controllers.js";
import { buildOpenApiDocument } from "../dist/bootstrap/swagger.js";

/** No AppModule, env files, database pools, watcher jobs or network listeners. */
export async function buildOfflineOpenApi() {
  const module = await Test.createTestingModule({ controllers: documentationControllers })
    .useMocker(() => ({})).compile();
  const app = module.createNestApplication({ logger: false });
  try { return buildOpenApiDocument(app); }
  finally { await app.close(); }
}
