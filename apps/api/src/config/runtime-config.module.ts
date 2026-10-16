import { Global, Module } from "@nestjs/common";
import { AppConfig } from "./app-config.js";
import { validateEnvironment } from "./runtime-config.js";
import { registerLiveDeployment } from "../copy/live-deployment.js";
import { registerLiveEvidenceWindow } from "./live-evidence-window.js";

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => {
    const config = new AppConfig(validateEnvironment());
    // The deployment's caps and allowlist, for the order-time risk authority.
    registerLiveDeployment(config.value.copy.live);
    // The evidence window: LIVE_EVIDENCE_MAX_AGE_MS, or on testnet COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS.
    registerLiveEvidenceWindow(config.value.hyperliquid.wallet.network, config.value.copy.testnetEvidenceMaxAgeMs);
    return config;
  } }],
  exports: [AppConfig],
})
export class RuntimeConfigModule {}
