import { expect, it } from "vitest";
import type { Type } from "@nestjs/common";
import * as c from "@trading-dashboard/shared/contracts";
import { createValidationPipe } from "../src/config/validation/validation-pipe.factory.js";
import { TradersQueryDto, PortfolioQueryDto, SparklinesQueryDto, FillsQueryDto, AnalyticsQueryDto, TradesQueryDto } from "../src/traders/dto/trader-query.dto.js";
import { AdminUsersQueryDto, AdminRevenueQueryDto, PatchAdminUserDto } from "../src/admin/dto/admin-query.dto.js";
import { PatchAdminSettingsDto } from "../src/admin/dto/settings.dto.js";
import { PatchMeDto, PatchFavoriteAlertDto } from "../src/users/dto/profile.dto.js";
import { ActionsFeedQueryDto, ActionsStreamQueryDto } from "../src/api/actions/dto/action-query.dto.js";
import { LeadersQueryDto, LeaderDetailQueryDto, PatchLeaderDto } from "../src/api/leaders/dto/leader.dto.js";
import { ListDiffQueryDto } from "../src/api/lists/dto/list-query.dto.js";
import { AlertsQueryDto } from "../src/api/alerts/dto/alerts-query.dto.js";
import { ImportListDto } from "../src/import/dto/import-list.dto.js";
import { UpsertRuleDto } from "../src/api/alert-rules/dto/rule.dto.js";
import { AddressParamsDto, ActionIdParamsDto, UserIdParamsDto } from "../src/common/dto/params.dto.js";
import { ResumeHeaderDto } from "../src/api/actions/dto/resume-header.dto.js";
const A = `0x${"AB".repeat(20)}`;
const pipe = createValidationPipe();
const validate = (metatype: Type<unknown>, value: unknown) => pipe.transform(value, { type: "body", metatype });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const cases: [Type<unknown>, { parse(input: unknown): unknown }, object][] = [
  [TradersQueryDto, c.tradersQuerySchema, {}],
  [TradersQueryDto, c.tradersQuerySchema, { hideVaults: "false", limit: "4", offset: "3" }],
  [PortfolioQueryDto, c.portfolioQuerySchema, {}],
  [AnalyticsQueryDto, c.traderAnalyticsQuerySchema, {}],
  [TradesQueryDto, c.traderTradesQuerySchema, { cursor: "123_-9223372036854775808" }],
  [AdminUsersQueryDto, c.adminUsersQuerySchema, { limit: "6", role: "admin" }],
  [AdminRevenueQueryDto, c.adminRevenueQuerySchema, {}],
  [ActionsFeedQueryDto, c.actionsFeedQuerySchema, { before: "2026-01-01", beforeId: "9223372036854775807", address: A }],
  [ActionsStreamQueryDto, c.actionsStreamQuerySchema, { scope: "favorites" }],
  [LeadersQueryDto, c.leadersQuerySchema, { active: "false" }],
  [LeaderDetailQueryDto, c.leaderDetailQuerySchema, {}],
  [ListDiffQueryDto, c.listDiffRequestSchema, { fromListId: "1", toListId: "2" }],
  [AlertsQueryDto, c.alertsQuerySchema, { address: A, ruleId: "2" }],
  [PatchMeDto, c.patchMeRequestSchema, { displayName: null, locale: "en" }],
  [PatchFavoriteAlertDto, c.patchFavoriteAlertRequestSchema, { minUsd: null, enabled: false }],
  [PatchAdminUserDto, c.patchAdminUserRequestSchema, { disabled: false }],
  [PatchLeaderDto, c.patchLeaderRequestSchema, { label: null, active: false }],
  [ImportListDto, c.importLeaderListRequestSchema, { fileName: "  file.csv ", rows: [{ address: A, customColumn: 7 }] }],
  [UpsertRuleDto, c.upsertAlertRuleRequestSchema, { scope: "address", kind: "R9", paramsJson: {}, cooldownS: 0, tiers: [] }],
  [PatchAdminSettingsDto, c.patchAdminSettingsRequestSchema, { general: { signupsOpen: false }, expectedRevisions: { general: "0".repeat(64) } }],
];
it.each(cases)("%s preserves contract defaults and explicit conversions", async (dto, schema, input) => {
  expect(json(await validate(dto, input))).toEqual(json(schema.parse(input)));
});
it.each([
  [TradersQueryDto, { hideVaults: "typo" }], [TradersQueryDto, { limit: "" }], [TradersQueryDto, { limit: ["2", "3"] }],
  [TradersQueryDto, { typo: "x" }], [ActionsFeedQueryDto, { beforeId: "1" }],
  [TradesQueryDto, { cursor: "123_9223372036854775808" }],
  [PatchMeDto, { locale: null }], [PatchAdminUserDto, { disabled: "false" }], [PatchFavoriteAlertDto, { enabled: null }],
  [PatchAdminSettingsDto, { general: { announcement: { enabled: false, text: { en: "", "zh-TW": "", secret: "x" } } } }],
  [PatchAdminSettingsDto, { general: null }], [PatchAdminSettingsDto, { general: { signupsOpen: "false" } }],
  [PatchAdminSettingsDto, { expectedRevisions: { bogus: "0".repeat(64) } }],
  [UpsertRuleDto, { scope: "address", kind: "R1", paramsJson: {}, cooldownS: 0, tiers: [] }],
  // Ids are int4 in the database: out of range is a 400 here, not a 500 there (review finding 37).
  [UpsertRuleDto, { id: 2147483648, scope: "address", kind: "R9", paramsJson: {}, cooldownS: 0, tiers: [] }],
  [UpsertRuleDto, { id: 0, scope: "address", kind: "R9", paramsJson: {}, cooldownS: 0, tiers: [] }],
  [AlertsQueryDto, { ruleId: "99999999999" }], [AlertsQueryDto, { ruleId: "-1" }], [AlertsQueryDto, { ruleId: "1.5" }],
  [PatchAdminSettingsDto, { general: { maxWatchedAddresses: 0 } }], [PatchAdminSettingsDto, { general: { maxWatchedAddresses: null } }],
  [ImportListDto, { fileName: "a", rows: [null] }],
  [ActionIdParamsDto, { id: "9223372036854775808" }], [AddressParamsDto, { address: "nope" }],
  [UserIdParamsDto, { id: "1oops" }], [ResumeHeaderDto, { lastEventId: "0" }],
] as [Type<unknown>, unknown][])("%s rejects invalid input before business code", async (dto, input) => {
  await expect(validate(dto, input)).rejects.toMatchObject({ status: 400 });
});
it("normalizes address paths and CSV query addresses while retaining exact header cursors", async () => {
  expect(await validate(AddressParamsDto, { address: A })).toMatchObject({ address: A.toLowerCase() });
  expect(await validate(SparklinesQueryDto, { addresses: `${A},${A}` })).toMatchObject({ addresses: [A.toLowerCase(), A.toLowerCase()], window: "month" });
  expect(await validate(FillsQueryDto, {})).toMatchObject({ limit: 50 });
  expect(await validate(ResumeHeaderDto, { lastEventId: "9223372036854775807" })).toMatchObject({ lastEventId: "9223372036854775807" });
});
it("does not materialize absent PATCH keys or revision entries on DTO instances", async () => {
  const dto = await validate(PatchAdminSettingsDto, { general: { signupsOpen: false }, expectedRevisions: { general: "0".repeat(64) } });
  expect(Object.hasOwn(dto.expectedRevisions, "discovery")).toBe(false);
  expect(Object.hasOwn(dto.general, "announcement")).toBe(false);
  expect(c.patchAdminSettingsRequestSchema.safeParse(dto).success).toBe(true);
});
it("shared request contracts and native DTOs both reject unknown fields", async () => {
  for (const [dto, schema, input] of cases) {
    const unknown = { ...input, unexpectedField: true };
    expect(() => schema.parse(unknown), dto.name).toThrow();
    await expect(validate(dto, unknown)).rejects.toMatchObject({ status: 400 });
  }
});

it.each([PatchMeDto, PatchFavoriteAlertDto, PatchLeaderDto])("%s rejects non-object root values", async dto => {
  for (const value of [[], true, 5, "", null]) await expect(validate(dto, value)).rejects.toMatchObject({ status: 400 });
});
