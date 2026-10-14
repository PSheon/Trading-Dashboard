import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { CopyLiveSetupService } from '../src/copy/copy-live-setup.service.js';
import { SetupSteps } from '../src/copy/copy-live-setup-steps.js';
import { SetupDriver } from '../src/copy/copy-live-setup-driver.js';
import { SetupProvisioning } from '../src/copy/copy-live-setup-provisioning.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';

/**
 * The live copy setup service was split on 2026-10-15 (review J-5) into an
 * HTTP facade (copy-live-setup.service.ts) that composes three plain parts:
 * the provisioning, the driver and the steps. Nothing about the setup
 * changed (copy-live-setup.spec.ts, unchanged, is the proof); these pin the
 * shape, so the split can't quietly grow back together or lose a wire.
 */
const environment = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!, ...extra });
/** The facade's parts and the parts' own wiring (private fields, read as data). */
const internals = (value: unknown) => value as Record<string, unknown>;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the setup service composes its parts through the real module graphs', () => {
  const graphs: ReadonlyArray<readonly [string, Record<string, string>]> = [['api', {}], ['copy worker', { IS_WORKER: 'true', WORKER_ROLE: 'copy' }]];
  it.each(graphs)('in the %s graph the facade holds one provisioning, one steps and one driver, wired to the same seams the module provides', async (_name, extra) => {
    vi.stubEnv('DATABASE_URL', process.env.TEST_DATABASE_URL!);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const config = new AppConfig(validateEnvironment(environment({ WORKER_URL: 'http://worker.internal:3000', ...extra })));
    const { AppModule } = await import('../src/app.module.js');
    const worker = config.value.app.isWorker;
    const ref = await Test.createTestingModule({ imports: [worker ? AppModule.worker(config.value.app.workerRole) : AppModule.api()] }).overrideProvider(AppConfig).useValue(config).compile();
    const app: INestApplicationContext = worker ? await ref.init() : ref.createNestApplication({ logger: false });
    try {
      if (!worker) await app.init();
      const service = app.get(CopyLiveSetupService, { strict: false });
      const facade = internals(service), steps = internals(facade.steps), driver = internals(facade.driver);
      expect(facade.provisioning).toBeInstanceOf(SetupProvisioning);
      expect(facade.steps).toBeInstanceOf(SetupSteps);
      expect(facade.driver).toBeInstanceOf(SetupDriver);
      // The driver drives the same steps and provisioning the facade holds.
      expect(driver.steps).toBe(facade.steps); expect(driver.provisioning).toBe(facade.provisioning);
      // The module's optional seams reached the parts: the shared meter's
      // setup lane (the wallet network's transport) and the setup bucket.
      expect(steps.capacity).toBeInstanceOf(HyperliquidGlobalTransport);
      expect(driver.capacity).toBe(steps.capacity);
      expect(typeof steps.setupBudget).toBe('function');
      // The worker signer is a module seam too: present or null, never undefined (an unwired `@Optional()`).
      expect(driver.workerSigner === null || typeof driver.workerSigner === 'object').toBe(true);
    } finally { await app.close(); }
  }, 60_000);
});

describe('the facade stays an HTTP facade', () => {
  const read = (name: string) => readFileSync(resolve(import.meta.dirname, `../src/copy/${name}`), 'utf8');
  it("imports no step weight, no budget reservation, no meter composition and no retry decision of its own: those are the parts'", () => {
    const facade = read('copy-live-setup.service.ts');
    for (const module of ['privy-account-mode-client', 'copy-agent-exchange.client', 'info-weights', 'hyperliquid-global-quota', 'error-class', 'explorer-health'])
      expect(facade, module).not.toMatch(new RegExp(`from '[^']*${module.replace('.', '\\.')}`));
    for (const name of ['ATTEMPT_STEP_WEIGHT', 'ACCOUNT_MODE_OBSERVE_WEIGHT', 'LiveBudgetReservation', 'sharedCapacityWait', 'HyperliquidBudgetWait', 'decideRetry', 'withCapacity', 'modeStep', 'agentStep', 'builderStep'])
      expect(facade, name).not.toContain(name);
    // Its callers' imports stay: what the file exported before the split is re-exported.
    for (const name of ['setupFundingKey', 'SETUP_REST_CAPACITY', 'SETUP_LOCAL_BUDGET', 'SETUP_CLAIM_RENEW_MS', 'AWAITING_CREDIT_MAX_WAIT_MS', 'type SetupSigner', 'type SetupRestCapacity'])
      expect(facade, name).toMatch(new RegExp(`export \\{[^}]*${name}[^}]*\\} from`));
  });
  it('the parts never import the facade (no cycle), and the facade is under 500 lines', () => {
    for (const name of ['copy-live-setup-shared.ts', 'copy-live-setup-steps.ts', 'copy-live-setup-driver.ts', 'copy-live-setup-provisioning.ts'])
      expect(read(name), name).not.toContain("from './copy-live-setup.service.js'");
    expect(read('copy-live-setup.service.ts').split('\n').length).toBeLessThan(500);
  });
});
