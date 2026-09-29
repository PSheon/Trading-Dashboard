import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE_CLIENT } from "./db.constants.js";
import type { DrizzleDb } from "./drizzle.provider.js";
export type DbTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
export type DbExecutor = DrizzleDb | DbTransaction;
/** Use cases own the transaction; all participating repositories receive this handle. */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  run<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> { return this.db.transaction(work); }
}
