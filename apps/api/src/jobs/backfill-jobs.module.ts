import { Module } from '@nestjs/common';
import { BackfillJobsRepository } from './backfill-jobs.repository.js';
/** Pure persistence; importing this module never starts work. */
@Module({
  providers: [BackfillJobsRepository],
  exports: [BackfillJobsRepository],
})
export class BackfillJobsModule {}
