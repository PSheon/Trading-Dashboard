import { Controller, Get, Header, Query } from "@nestjs/common";
import { Public } from "../common/auth/public.decorator.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { TraderSearchQueryDto } from "./dto/trader-search.dto.js";
import { TraderSearchRepository } from "./trader-search.repository.js";
@Public()
@Controller("trader-search")
export class TraderSearchController {
  constructor(private readonly repository: TraderSearchRepository) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiDoc("Find known traders by address prefix, name or X handle")
  search(@Query() query: TraderSearchQueryDto) {
    return this.repository.search(query.q);
  }
}
