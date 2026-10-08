import type { FactoryProvider } from '@nestjs/common';
import * as schema from '@trading-dashboard/shared/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import { DATABASE_POOL } from '../../db/drizzle.provider.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from '../../hyperliquid/wallet-network-hyperliquid.js';
import { liveBudget } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { CopyFollowerLedger } from '../live/copy-follower-ledger.js';
import { HyperliquidFollowerReceiptReader } from '../live/follower-receipt-reader.js';
import { CopyFollowerScanRepository } from '../copy-follower-scan.repository.js';
import { CopyFollowerReconciler } from '../copy-follower-monitor.service.js';
import { CopyFollowerSnapshotRepository } from '../copy-follower-snapshot.repository.js';
import { CopyLiveSettler } from './copy-live-settler.js';
import { CopyLiveApiSettlementRepository } from './copy-live-api-settlement.repository.js';
import { CopyLiveSettlementClaims } from './copy-live-settlement-claim.js';
import { settlementFencedPool } from './copy-live-settlement-fenced-pool.js';
import { CopyLiveApiSettlementService } from './copy-live-api-settlement.service.js';

export const apiSettlementProvider: FactoryProvider<CopyLiveApiSettlementService> = {
  provide: CopyLiveApiSettlementService,
  inject: [AppConfig, DATABASE_POOL, WALLET_NETWORK_HL, BackgroundJobs],
  useFactory: (config: AppConfig, pool: Pool, wallet: WalletNetworkHyperliquid, jobs: BackgroundJobs) => {
    const plain = new CopyLiveApiSettlementRepository(drizzle(pool, { schema }));
    return new CopyLiveApiSettlementService(config, jobs, plain, new CopyLiveSettlementClaims(pool), claim => {
      const db = drizzle(settlementFencedPool(pool, claim), { schema });
      const { budget, transport, network } = wallet;
      // This scanner is reached only after the original terminal execution and
      // reservation identity were loaded under this settlement claim. Its
      // receipts are financial release evidence, not ordinary reporting.
      // Use the existing live reserve; caps and the bucket's forced ordinary
      // fairness remain unchanged. Scheduled account scans stay background.
      const reserve = liveBudget(budget, { maxWaitMs: 5000, signal: claim.signal });
      const fetcher: typeof fetch = async (input, init) => {
        await claim.assertHeld();
        const result = await transport.fetchInfo(input, { ...init, signal: init?.signal ? AbortSignal.any([claim.signal, init.signal]) : claim.signal });
        await claim.assertHeld(); return result;
      };
      const scanner = new CopyFollowerReconciler(new CopyFollowerScanRepository(db, config), new CopyFollowerLedger(db, new UnitOfWork(db)),
        new HyperliquidFollowerReceiptReader(network, reserve, fetcher, Date.now, weight => { if (weight > 0) budget.adjust(-weight); },
          { acquire: liveBudget(budget, { maxWaitMs: Math.min(180000, budget.refillMs()), signal: claim.signal }), maxWaitMs: Math.min(180000, budget.refillMs()) + 2000 }));
      const settler = new CopyLiveSettler(network, pool, transport, budget, scanner);
      return { repository: new CopyLiveApiSettlementRepository(db), settle: request => settler.settle(request, claim),
        saveSettlement: key => new CopyFollowerSnapshotRepository(db, config).saveSettlement(key) };
    });
  },
};
