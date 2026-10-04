import "reflect-metadata";
import { EXCEPTION_FILTERS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { CopyLiveCloseController } from "../src/copy/copy-live-close.controller.js";
import { CopyLiveReturnController } from "../src/copy/copy-live-return.controller.js";
import { CopyLiveStopController } from "../src/copy/copy-live-stop.controller.js";
import { BusyFilter } from "../src/traders/busy.js";

describe("testnet copy owner routes under a full capacity queue", () => {
  it("answer 503 with Retry-After (BusyFilter) on close, as on stop and return", () => {
    for (const controller of [CopyLiveCloseController, CopyLiveStopController, CopyLiveReturnController]) {
      expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, controller) ?? [], controller.name).toContain(BusyFilter);
    }
  });
});
