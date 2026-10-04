import { Controller, Get, Query } from "@nestjs/common";
import { ApiPropertyOptional } from "@nestjs/swagger";
import type { FundsHistoryResponse } from "@trading-dashboard/shared/contracts";
import { IsInt, Matches, Max, Min } from "class-validator";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { Optional, ToNumber } from "../common/decorators/input.decorator.js";
import { CopyFundsService } from "./copy-funds.service.js";

export class FundsHistoryQueryDto {
  @ApiPropertyOptional({ type: String, pattern: "^\\d{1,16}$", description: "Epoch ms: only flows before it (the previous page's nextCursor)" })
  @Optional() @Matches(/^\d{1,16}$/) declare before?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 50 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(100) declare limit?: number;
}

@Controller("me/funds")
export class CopyFundsController {
  constructor(private readonly funds: CopyFundsService) {}

  @ApiDoc("List my money flows: copy transfers, fees, funding, hub withdrawals")
  @Get("history")
  history(@Query() query: FundsHistoryQueryDto, @CurrentUser() user: RequestUser | null): Promise<FundsHistoryResponse> {
    return this.funds.history(requireUserId(user), query);
  }
}
