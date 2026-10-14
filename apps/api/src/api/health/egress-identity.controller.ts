import { Controller, Get, Headers, NotFoundException } from "@nestjs/common";
import type { EgressIdentity } from "@trading-dashboard/shared/contracts";

import { Public } from "../../common/auth/public.decorator.js";
import { ApiDoc, SkipTransform } from "../../common/decorators/http.decorator.js";
import { AppConfig } from "../../config/app-config.js";
import { egressIdentityFor } from "../../runtime/egress-identity.js";
import { workerMonitorKey } from "../../runtime/worker-calls.js";

@SkipTransform()
@Controller("health")
export class EgressIdentityController {
  constructor(private readonly config: AppConfig) {}

  /**
   * This api process's public egress identity (HL_EGRESS_IDENTITY), read by
   * the copy worker's lease gate (HL_EGRESS_PEERS): only a caller with the
   * worker monitor key (derived from DATABASE_URL); anyone else gets a 404,
   * as for an unknown path.
   */
  @Public()
  @ApiDoc("Egress identity (worker monitor key)")
  @Get("egress")
  egress(@Headers("authorization") authorization: string | undefined): EgressIdentity {
    const identity = egressIdentityFor(authorization, workerMonitorKey(this.config.value.database.url));
    if (!identity) throw new NotFoundException();
    return identity;
  }
}
