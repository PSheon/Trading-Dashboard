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
import { TRANSFERS_MAX_ROWS, TRANSFERS_WINDOW_MS } from "../traders/traders.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { ArbitrumBalanceClient } from "./arbitrum-balance.client.js";
import { WalletRepository } from "./wallet.repository.js";

/** Balances: short enough that a deposit shows up within a poll or two
 * (Bridge2 credits in under a minute), long enough that a page's header
 * pill, portfolio and modal share one read. Weight 4 per refresh. */
export const WALLET_TTL_MS = 15_000;
/** Ledger: 20 weight + 1 per 20 rows; a withdrawal takes minutes anyway. */
export const WALLET_HISTORY_TTL_MS = 60_000;
/** A user without a stored embedded wallet is looked up at Privy at most
 * this often: the browser creates the wallet right after login, so the
 * first reads may come before Privy has it. */
export const WALLET_ADDRESS_RETRY_MS = 15_000;

const toNumber = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The signed-in user's main account (their Privy embedded wallet) on the
 * wallet network (HYPERLIQUID_NETWORK): Hyperliquid perp/spot balances, the
 * deposit address's Arbitrum balances, and the deposit/withdraw ledger.
 *
 * The address comes from Privy's own user record (the verifier's
 * `fetchProfile`), never from the browser. Reads only: nothing here signs,
 * and no key or signer reference is stored. Every Hyperliquid call goes
 * through the shared budgeter; results are cached per address.
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
   * The user's embedded wallet address (lowercase), or null while Privy has
   * none. A missing address is fetched from Privy (throttled per user) and
   * stored once.
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
          this.logger.warn(`Arbitrum balance for ${address}: ${error.message}`);
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

  /** GET /me/wallet/history: the 90-day ledger of the main account on the
   * wallet network, newest first (one page: a user wallet's ledger is small;
   * `truncated` says when it wasn't). */
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
