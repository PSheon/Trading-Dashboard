import { Controller, Get, Query } from "@nestjs/common";
import type { FundsHistoryResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { CopyFundsService } from "./copy-funds.service.js";
import { FundsHistoryQueryDto } from "./dto/copy.dto.js";

@Controller("me/funds")
export class CopyFundsController {
  constructor(private readonly funds: CopyFundsService) {}

  @ApiDoc("List my money flows: copy transfers, fees, funding, hub withdrawals")
  @Get("history")
  history(@Query() query: FundsHistoryQueryDto, @CurrentUser() user: RequestUser | null): Promise<FundsHistoryResponse> {
    return this.funds.history(requireUserId(user), query);
  }
}
