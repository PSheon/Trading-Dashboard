import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import {
  WALLET_NETWORKS,
  type WalletHistoryResponse,
  type WalletResponse,
} from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { PRIVY_VERIFIER, type PrivyVerifier } from "../common/auth/privy-verifier.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import { toTraderTransfer } from "../traders/trader-tabs.mappers.js";
import { TRANSFERS_MAX_ROWS } from '../traders/traders.service.js';
import { TtlCache } from "../traders/ttl-cache.js";
import { ArbitrumBalanceClient } from "./arbitrum-balance.client.js";
import { WalletRepository } from "./wallet.repository.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { TRANSFERS_WINDOW_MS, WALLET_ADDRESS_RETRY_MS, WALLET_HISTORY_TTL_MS, WALLET_TTL_MS } from '../config/constants/cache-ttls.js';


const toNumber = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The user's main account (Privy embedded wallet) on the wallet network: HL balances,
 * Arbitrum balances and the ledger. The address comes from Privy, never the browser.
 * Read-only: nothing signs, no key is stored. Cached per address.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly addressRetryAt = new Map<number, number>();
  readonly summaryCache = new TtlCache<WalletResponse>(WALLET_TTL_MS);
  readonly historyCache = new TtlCache<WalletHistoryResponse>(WALLET_HISTORY_TTL_MS);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: WalletRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly arbitrum: ArbitrumBalanceClient,
    @Inject(PRIVY_VERIFIER) private readonly privy: PrivyVerifier,
    /** The wallet network's own budget and egress (testnet's), not mainnet's. */
    @Optional() @Inject(WALLET_NETWORK_HL) private readonly walletNetwork: WalletNetworkHyperliquid | null = null,
  ) {}
  private get walletInfo(): HyperliquidInfoClient { return this.walletNetwork?.info ?? this.info; }

  private get wallet() {
    return this.config.value.hyperliquid.wallet;
  }

  /**
   * Embedded wallet address (lowercase), or null while Privy has none; a missing one is
   * fetched (throttled per user) and stored once.
   * @throws NotFoundException when the user row is gone.
   */
  async address(userId: number): Promise<string | null> {
    const row = await this.repository.findWallet(userId);
    if (!row) throw new NotFoundException("User not found");
    if (row.embeddedWalletAddress) return row.embeddedWalletAddress;

    const now = Date.now();
    if ((this.addressRetryAt.get(userId) ?? 0) > now) return null;
    this.addressRetryAt.set(userId, now + WALLET_ADDRESS_RETRY_MS);
    const embedded = (await this.privy.fetchProfile(row.privyUserId))?.embeddedWalletAddress ?? null;
    if (!embedded) return null;
    this.addressRetryAt.delete(userId);
    return this.repository.setEmbeddedWallet(userId, embedded.toLowerCase());
  }

  /** GET /me/wallet. Hyperliquid failures propagate (the controller answers
   * 502 / 503 busy); an Arbitrum RPC failure only nulls `arbitrum`. */
  async summary(userId: number): Promise<WalletResponse> {
    const network = this.wallet.network;
    const address = await this.address(userId);
    if (!address) {
      return { network, address: null, hyperliquid: null, arbitrum: null, totalValue: 0, fetchedAt: new Date() };
    }
    return this.summaryCache.get(`${network}:${address}`, async () => {
      const url = this.wallet.infoUrl;
      const [perp, spot, arbitrum] = await Promise.all([
        this.walletInfo.clearinghouseState(address, undefined, "background", PAGE_RANK.profile, url),
        this.walletInfo.spotClearinghouseState(address, "background", PAGE_RANK.profile, url),
        this.arbitrum.balances(address, WALLET_NETWORKS[network].usdc).catch((error: Error) => {
          this.logger.warn(`Arbitrum balance for ${address}: ${safeErrorText(error)}`);
          return null;
        }),
      ]);
      const usdc = spot.balances.find((b) => b.coin === "USDC");
      const hyperliquid = {
        perpValue: toNumber(perp.marginSummary.accountValue),
        withdrawable: toNumber(perp.withdrawable),
        spotUsdc: toNumber(usdc?.total),
        spotUsdcHold: toNumber(usdc?.hold),
      };
      const totalValue = hyperliquid.perpValue + hyperliquid.spotUsdc + (arbitrum?.usdc ?? 0);
      return { network, address, hyperliquid, arbitrum, totalValue, fetchedAt: new Date() };
    });
  }

  /** GET /me/wallet/history: the TRANSFERS_WINDOW_MS ledger, newest first, one page
   * (`truncated` when it didn't fit). */
  async history(userId: number): Promise<WalletHistoryResponse> {
    const network = this.wallet.network;
    const address = await this.address(userId);
    const from = new Date(Date.now() - TRANSFERS_WINDOW_MS);
    if (!address) return { network, address: null, transfers: [], from, truncated: false, fetchedAt: new Date() };
    return this.historyCache.get(`${network}:${address}`, async () => {
      const rows = await this.walletInfo.userNonFundingLedgerUpdates(
        address, from.getTime(), undefined, "background", PAGE_RANK.fills, this.wallet.infoUrl,
      );
      const transfers = rows
        .map((u) => toTraderTransfer(u, address))
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .sort((a, b) => b.time.getTime() - a.time.getTime());
      return {
        network,
        address,
        transfers: transfers.slice(0, TRANSFERS_MAX_ROWS),
        from,
        truncated: transfers.length > TRANSFERS_MAX_ROWS,
        fetchedAt: new Date(),
      };
    });
  }
}
