import { Global, Module } from "@nestjs/common";
import { AppConfig } from "./app-config.js";
import { validateEnvironment } from "./runtime-config.js";

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig(validateEnvironment()) }],
  exports: [AppConfig],
})
export class RuntimeConfigModule {}
