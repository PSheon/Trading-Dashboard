import { PatchMeDto } from "../src/users/dto/profile.dto.js";
import { ResponseMessage, SkipTransform } from "../src/common/decorators/http.decorator.js";
import { Body, Controller, Get, Module, Post, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Type, Transform } from "class-transformer";
import { IsBoolean, IsInt, IsString, Max, ValidateNested } from "class-validator";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { HttpModule } from "../src/common/http/http.module.js";

class ChildDto { @IsBoolean() enabled!: boolean; }
class InputDto {
  @Transform(({ value }) => typeof value === "string" ? Number(value) : value, { toClassOnly: true })
  @IsInt() @Max(10) count!: number;
  @IsString() name!: string;
  @Type(() => ChildDto) @ValidateNested() child!: ChildDto;
}
let calls = 0;
@Controller()
class PipelineProbe {
  @Post("optional") optional(@Body() body: PatchMeDto) { calls++; return body; }
  @SkipTransform() @Post("pipeline") create(@Body() body: InputDto) { calls++; return { instance: body instanceof InputDto, ...body }; }
  @Get("actions") @ResponseMessage("Actions loaded") actions() { return []; }
  @Get("raw-probe") @SkipTransform() raw() { return { raw: true }; }
}
@Module({ imports: [HttpModule], controllers: [PipelineProbe] }) class ProbeModule {}
let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
});
afterAll(async () => { await app.close(); });
it("runs class transformation and nested whitelist validation globally before controller invocation", async () => {
  const valid = { count: "3", name: "test", child: { enabled: false } };
  expect((await request(app.getHttpServer()).post("/pipeline").send(valid).expect(201)).body).toMatchObject({ instance: true, count: 3 });
  const before = calls;
  for (const body of [{ ...valid, surprise: 1 }, { ...valid, child: { enabled: "false" } }, { ...valid, child: { enabled: false, secret: 1 } }, { ...valid, count: "3oops" }]) {
    const res = await request(app.getHttpServer()).post("/pipeline").send(body).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  }
  expect(calls).toBe(before);
});
it("uses explicit response metadata for messages and non-enveloped endpoints", async () => {
  expect((await request(app.getHttpServer()).get("/actions").set("x-api-contract", "1").expect(200)).body.message).toBe("Actions loaded");
  expect((await request(app.getHttpServer()).get("/raw-probe").set("x-api-contract", "1").expect(200)).body).toEqual({ raw: true });
});

it("rejects array bodies even when every DTO property is optional", async () => {
  const before = calls;
  await request(app.getHttpServer()).post("/optional").send([]).expect(400);
  expect(calls).toBe(before);
});
