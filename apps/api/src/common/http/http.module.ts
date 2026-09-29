import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { TransformInterceptor } from "./transform.interceptor.js";
@Module({ providers: [
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
] })
export class HttpModule {}
