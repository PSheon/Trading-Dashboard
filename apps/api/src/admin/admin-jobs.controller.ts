import { JobsQueryDto, JobIdDto, RetryJobDto } from "./dto/jobs.dto.js";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiDoc,
  ResponseMessage,
} from "../common/decorators/http.decorator.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { BackfillJobsRepository } from "../jobs/backfill-jobs.repository.js";

@Controller("admin/jobs")
@RequirePermissions("jobs.read")
export class AdminJobsController {
  constructor(private readonly repository: BackfillJobsRepository) {}
  @ApiDoc("List initial backfill jobs")
  @Get()
  @Header("Cache-Control", "no-store")
  list(@Query() query: JobsQueryDto) {
    return this.repository.list(query);
  }

  @ApiDoc("Requeue a failed backfill job")
  @RequirePermissions("jobs.retry")
  @ResponseMessage("Backfill queued")
  @Post(":id/retry")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  retry(
    @Param() params: JobIdDto,
    @Body() body: RetryJobDto,
    @CurrentUser() actor: RequestUser | null,
  ) {
    return this.repository.retry(params.id, body.expectedVersion, actor);
  }
}
