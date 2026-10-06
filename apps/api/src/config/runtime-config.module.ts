import { Global, Module } from "@nestjs/common";
import { AppConfig } from "./app-config.js";
import { validateEnvironment } from "./runtime-config.js";
import { registerLiveDeployment } from "../copy/live-deployment.js";

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => {
    const config = new AppConfig(validateEnvironment());
    // The deployment's caps and allowlist, for the order-time risk authority.
    registerLiveDeployment(config.value.copy.live);
    return config;
  } }],
  exports: [AppConfig],
})
export class RuntimeConfigModule {}
