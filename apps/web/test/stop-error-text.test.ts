import { expect, it } from "vitest";

import { copyErrorMessages } from "@/i18n/copy-errors";
import { liveSetupText } from "@/i18n/live-setup";
import { liveStopMessages } from "@/i18n/copy-live-stop";
import { ApiError } from "@/lib/api";
import { copyErrorText, stopErrorText } from "@/lib/copy-error-text";

/**
 * A stop's failure (audit 2026-10-07 P1-5): a refusal the api answered is
 * said in its own words; 「查詢原始申請」 only when the outcome is unknown.
 */
const texts = { live: liveSetupText("zh-TW", "mainnet"), extra: copyErrorMessages["zh-TW"] };
const unknown = liveStopMessages["zh-TW"].error;

it("a definite refusal in its words, an unknown outcome points at the original request", () => {
  expect(stopErrorText(texts, new ApiError(409, "Conflict", { code: "live_stop_pending" }), unknown)).toBe("這個跟單已在停止中。");
  expect(stopErrorText(texts, new ApiError(409, "Conflict", { code: "stale_revision" }), unknown)).toBe("這個跟單的狀態已更新，請重新整理後再試。");
  expect(stopErrorText(texts, new ApiError(429, "Too many"), unknown)).toBe(texts.extra.rateLimited);
  expect(stopErrorText(texts, new ApiError(503, "Busy", { code: "busy" }), unknown)).toBe(unknown);
  expect(stopErrorText(texts, new TypeError("Failed to fetch"), unknown)).toBe(unknown);
  expect(stopErrorText(texts, new Error("stop_result_changed"), unknown)).toBe(unknown);
  expect(unknown).toContain("查詢原始申請");
});

it("a withdrawal refused for lack of idle funds says so, never the generic line", () => {
  expect(copyErrorText(texts, new ApiError(409, "Conflict", { code: "no_free_collateral" }))).toBe("目前沒有可提款的閒置資金，資金正用於持倉保證金。");
});
