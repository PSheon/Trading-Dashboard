# FAQ

<!-- Draft. Each ### is one expandable question. Copy trading has paper (simulated) and Hyperliquid testnet modes (testnet uses test USDC with no real value); anything marked "planned" is not available yet. Recheck the text when copying with real funds launches. -->

## About Orbie

### What is Orbie?

Orbie (app.orbie.fun) is a trader-monitoring and copy-trading platform for Hyperliquid. You can browse the performance of every trader on Hyperliquid, dig into their positions and trade history, favorite the ones you like, and get Telegram alerts when they trade. Paper (simulated) copy trading is available now: it uses virtual funds, sends no orders to Hyperliquid, and its results are estimates. Copying with real funds is not available yet.

### What is Hyperliquid?

Hyperliquid is a high-performance on-chain exchange for perpetual futures and spot trading. Every fill and position is recorded on-chain and publicly visible, which is why Orbie can analyze any trader.

### Which markets does Orbie support?

Hyperliquid only, including crypto perpetuals and perpetuals on other Hyperliquid markets such as stocks. Performance metrics are mostly based on perpetuals; some also include spot, as noted under each metric below.

### Does Orbie cost anything?

Browsing, search, favorites, Telegram alerts and paper copy trading are free. See "Fees" below for the fee planned for copying with real funds.

## Data sources and update frequency

### Where does Orbie's data come from?

All of it comes from Hyperliquid's public API and official leaderboard. Orbie doesn't need a trader's permission and never gets anyone's private data: what we see is what Hyperliquid publishes about fills, positions and account value.

### How often is the data updated?

- **Leaderboard and Explore:** refreshed from Hyperliquid's official leaderboard about every 15 minutes.
- **Trader pages (account value, positions, charts):** read from Hyperliquid when you open the page and cached for up to about a minute; the small charts on cards refresh about every 10 minutes.
- **Trade history, win rate and other trade analytics:** recalculated in the background, so figures can lag by up to about 10 minutes. The first time anyone opens a trader, it takes a few seconds to prepare the data.
- **Favorited or monitored traders:** Orbie receives their fills in real time for Telegram alerts and the activity feed.

### Why is some traders' history incomplete?

Hyperliquid serves a limited fill history per account (its documentation states the most recent 10,000 fills). For very active accounts, older trades may no longer be available, so trade count and win rate only cover the period we can read. When a trade was opened before the available history, it is shown as "before …". Orbie saves the fills it receives after monitoring begins. Disconnects and provider limits can still leave gaps; saving fills does not prove the entire period is complete. When the trades Orbie could read do not reach back to the account's start, the win-rate tile says so ("24 Trades since 09/26/2026") instead of presenting them as all-time.

### Why do Orbie's numbers differ from other sites?

Usually for one of three reasons: the data was taken at a different time (some sites show metrics from a snapshot up to a day old), a different length of history was available, or the definition is different. Every Orbie definition is listed below.

## Understanding the metrics

### What is PnL?

The account's profit and loss over the selected period (all time, 30 days, 7 days, 24 hours), taken from Hyperliquid's account PnL history. Home and Explore show perpetuals PnL by default.

### How is ROI calculated?

ROI = PnL for the period ÷ the highest capital invested during the period. "Capital invested" is account value minus cumulative PnL, in other words net deposits. Using the highest value in the period stops a trader from inflating ROI by depositing a lot, making a profit and withdrawing. If capital is zero or negative, ROI shows 0.

The small figure under ROI is the annualized return. When the record is shorter than 90 days, the annualized figure is an extrapolation and should be read with care.

### What is the Sharpe ratio?

It measures how much return a trader earns for each unit of volatility. Orbie computes returns from changes in the whole account's PnL (perpetuals plus spot), divides their average by their standard deviation, and annualizes the result based on the spacing of the data points. Higher means steadier returns; negative means the account is losing money overall. Sharpe uses the full history.

### What is max drawdown?

The largest fall from a previous peak, as a percentage. For example, 40% means the account once lost four tenths of its value from a high. It answers "how bad did it get?" and belongs next to ROI. Max drawdown uses the full history.

### How is win rate calculated?

Win rate = profitable closed trades ÷ all closed trades.

- **A trade** is a position in one coin from the moment it leaves zero until it returns to zero; adds and partial closes along the way are part of the same trade. When a position flips directly from long to short (or the reverse), it counts as closing the old trade and opening a new one.
- **Profitable** means net PnL after trading fees is above 0. Funding payments are not included.
- Trades closed by liquidation count like any other. Trades settled by the exchange's auto-deleveraging (ADL) or by a market being delisted are left out.
- For 30-day, 7-day and other periods, a trade belongs to the period in which it closed.

A high win rate doesn't mean a trader makes money: someone can win nine small trades and lose everything on the tenth. Read it together with PnL and max drawdown.

### What is the copy score?

The copy score (0–98) compares traders within Orbie's eligible candidate pool. ROI and Sharpe each contribute 30%, while total PnL and track-record length each contribute 20%. Each component is ranked within that pool, and the combined result is ranked again. Around 80 represents roughly the top fifth of the scored pool; it does not establish a rank among every Hyperliquid account.

A few notes:

- Track-record length is compared with the other scored traders; there is no fixed penalty at 90 days.
- Tied results share a score. A pool containing one eligible trader gives that trader the neutral score of 49.
- The score is an estimated relative ranking based on public metrics. It is not a promise of profit and not a recommendation from Orbie.
- Missing inputs, dust accounts, dormant accounts and accounts excluded by the local activity filters are not scored. An unknown score is not zero. The eligible pool can change as data is refreshed.

### How is trading style determined?

By the median holding time of closed trades:

| Style | Median holding time |
| --- | --- |
| Scalper | under 15 minutes |
| Intraday | 15 minutes to 24 hours |
| Swing | 24 hours to 14 days |
| Position | 14 days or more |

### What are PnL tiers?

Tiers based on the trader's all-time perpetuals PnL (the trader page's Performance figure; spot is not counted):

| Tier | All-time PnL |
| --- | --- |
| Extremely profitable | ≥ $1M |
| Highly profitable | $100K – $1M |
| Profitable | $0 – $100K |
| Break-even | $0 |
| Losing | $0 to −$100K |
| Heavy losses | −$100K to −$1M |
| Wipeout losses | ≤ −$1M |

<!-- English tier names must match the app's en locale once it ships; adjust if they differ. -->

### What are size tiers?

Tiers based on the whole account's value (perpetuals, spot and staked HYPE: the account value on the trader page):

| Tier | Account value |
| --- | --- |
| Top | ≥ $5M |
| Whale | $1M – $5M |
| Large | $100K – $1M |
| Mid | $10K – $100K |
| Small | < $10K |

### What do the "Low sample" and "Vault" labels mean?

- **Low sample:** fewer trades in the last 30 days than the threshold (20 by default). With so few trades, results may be luck; read them with caution.
- **Vault:** a pooled-fund account on Hyperliquid. Its account value is the total of many depositors' money, not one trader's capital. Vaults are hidden on Explore by default and can be shown with a toggle.

## Signing in and your account

### How do I sign in?

Click "Sign in" at the top right. You can use email (with a one-time code), a Google account or an existing crypto wallet. Sign-in is provided by Privy. You can browse the leaderboard and any trader page without signing in; favorites, alerts, the wallet and copy trading need an account.

### What happens when I sign in?

The first time you sign in, Privy creates a wallet just for you. This wallet is your main account on Hyperliquid and holds your funds.

## Wallet, deposits and withdrawals

### Are my funds safe? Who controls my wallet?

You do. Your wallet's private key is held in Privy's secure infrastructure. Orbie's servers and website never see it and cannot obtain it. Orbie cannot withdraw for you and cannot move your funds.

Every on-chain asset carries risk, though. Protect the email, Google account or wallet you sign in with, and keep an exported private key somewhere safe.

### How do I deposit?

1. Open "Portfolio" and click "Deposit". You'll see your main account address and a QR code.
2. From an exchange or another wallet, send **USDC on the Arbitrum network** to that address. The USDC arrives at your own address on Arbitrum first; it is not on Hyperliquid yet.
3. Open "Deposit" again. The window shows the amount waiting. Press "Bridge to Hyperliquid" and your own wallet signs the transfer to Hyperliquid's bridge.
4. About a minute after you bridge, the funds are in your Hyperliquid account.

Please note:

- The minimum deposit is **5 USDC**. Hyperliquid's bridge does not credit smaller amounts, and USDC sent to the bridge below the minimum is lost, so Orbie does not let you bridge a balance under 5 USDC. Top it up first.
- Only USDC on Arbitrum is supported. Sending another token or using another network can result in permanent loss.
- If you already have funds on Hyperliquid, you can also transfer them to your main account inside Hyperliquid.
- The network fee for sending USDC to your address is charged by the exchange or wallet you send from.
- The bridge step needs a small Arbitrum network fee, paid in ETH from your wallet. If your wallet holds too little ETH, Orbie asks Privy to cover the fee; if that isn't available, you need to send a small amount of ETH on Arbitrum to your address first. Orbie charges nothing for this step.

### How do I withdraw?

Open "Portfolio", click "Withdraw", and enter an amount and destination address. Withdrawals are sent as USDC to an address on Arbitrum, and Hyperliquid charges a **1 USDC** fee. You sign the withdrawal with your own wallet; Orbie cannot start one for you. Funds usually arrive within minutes, depending on Hyperliquid's processing.

### How do I export my private key?

Choose "Export private key" in Portfolio or Settings. After you verify your identity with Privy, the key is shown in a secure window provided by Privy that Orbie cannot see into. You can then import the key into any EVM-compatible wallet and use your Hyperliquid account directly.

**Your private key is your money.** Anyone who has it can take your funds. Don't screenshot it, upload it to cloud storage or send it to anyone. Orbie staff will never ask for it.

### Where can I see my deposits and withdrawals?

Portfolio lists your deposits, withdrawals and transfers, as reported by Hyperliquid.

## Copy trading

<!-- Describes paper and testnet modes as shipped. Parts marked "planned" describe copying with real funds; rewrite them against the shipped feature before launch. -->

### How does copy trading work?

Copy trading has two modes. **Paper** uses virtual funds, sends no order to Hyperliquid, and its results are estimates. **Testnet** places real orders for you on Hyperliquid testnet with test USDC, which has no real value. Copying with real funds (mainnet) is not available yet.

1. Choose a direction and an amount in the copy panel on a trader's page. The amount comes from your paper account, which starts with 10,000 virtual USDC.
2. When the trader's fill is confirmed, Orbie simulates a matching order for your copy at the current market price, with an estimated trading fee and slippage.
3. Pause or stop the copy at any time.

Testnet copies: each copy has its own dedicated copy account, a wallet you own. You move test USDC into it from your main wallet and grant Orbie a restricted trading agent on Hyperliquid that **can only place and cancel orders**; Orbie then places orders for you according to your settings. Copying with real funds (planned) will work the same way.

### What's the difference between "same direction" and "reverse"?

- **Same direction:** when they go long, you go long; when they go short, you go short.
- **Reverse:** you take the opposite side. Useful if you think a trader is often wrong.

### Can Orbie touch my funds when it trades for me?

Paper copy trading does not touch your wallet at all: it uses virtual funds and sends no orders.

Testnet copies (and, when they launch, copies with real funds): Orbie only receives a restricted trading permission. It is technically limited to trading actions such as placing and cancelling orders, and **cannot withdraw or send funds to any other address**. You can revoke it at any time, and you can export the copy wallet's private key in Settings.

### Will I get the same price as the trader?

No, not exactly. Orbie acts after the trader's fill is confirmed, so there is a delay and the price may have moved (slippage). Your position size, available margin and leverage also differ from theirs. Your results will differ from the trader's, and can even go the other way. Paper results are estimates as well: real orders could fill at different prices, partially or not at all.

### Can I copy several traders at once?

Yes. In paper mode your account gets a virtual balance of 10,000 USDC, orders are simulated and no real order is sent. In testnet mode each copy has its own copy account and budget. In both modes you copy each trader once, and you can run up to 10 copies at the same time. Each copy needs an allocation of at least 100 USDC, and a single order smaller than 10 USD is not placed. These limits may change, including when copying with real funds becomes available.

### What happens to my positions and funds when I stop copying?

When you stop a copy, Orbie stops opening new positions for it, cancels its pending orders and closes its open positions at the market price. Once every position is closed, the copy's remaining balance returns to your available balance. Until then the copy shows "Stopping", and a stopping copy cannot be resumed.

Paper copies use virtual positions and virtual funds: no real order is sent and your wallet is not touched. When you stop a testnet copy, Orbie cancels its orders on Hyperliquid testnet and closes its positions with reduce-only market orders; once it is flat, you sign once with your main wallet to return the copy account's funds to it. Copying with real funds is not available yet; we will update this answer when it is.

## Fees

### How does Orbie make money?

- **Browsing, favorites, Telegram alerts:** free.
- **Paper copy trading:** free. Simulated results include an estimated Hyperliquid trading fee, but nothing is actually charged.
- **Testnet copy trading:** Orbie charges nothing (the builder fee is 0). If that changes, the maximum fee will be part of the copy consent you sign.
- **Copying with real funds (planned, not available yet):** Orbie plans to charge a fee on each copied fill through Hyperliquid's builder fee mechanism. The exact rate will be shown to you before you sign the approval. It will never exceed the maximum you sign, and under Hyperliquid's rules it cannot exceed 0.1% on perpetuals. Before you start copying with real funds, you will approve this maximum rate by signing with your own wallet.
- **Referral rebates:** Orbie may take part in Hyperliquid's referral program and receive rebates. These rebates do not change the fees you pay to Hyperliquid, and they do not give you a fee discount.

### What other costs are there?

- Hyperliquid's own trading fees and funding payments (as published by Hyperliquid).
- Hyperliquid's 1 USDC withdrawal fee.
- Arbitrum network fees for deposits, if any.

Orbie adds no fee of its own to deposits or withdrawals.

## Telegram alerts

### How do I set up alerts?

1. Sign in, go to Settings and click "Connect Telegram".
2. Open the link. It takes you to the official bot **@orbie_fun_bot**; press "Start" to finish linking. (The link works once and expires after 10 minutes.)
3. Back in Favorites or on a trader's page, click the bell to turn on alerts, choose buys, sells or both, and optionally set a minimum size.

### How many traders can I get alerts for?

Up to 3 at the moment (the site may change this limit).

### Which actions trigger an alert?

Opening, adding to, reducing, closing and flipping a position. Fills within the same second are grouped into one action, so you get one message instead of a flood. Every message includes the original trade time.

### How fast are alerts?

We aim to deliver them within seconds of the trade. Network or Telegram problems can delay them, and on rare occasions you may receive a duplicate.

### How do I know the bot is genuine?

Orbie's only official bot is **@orbie_fun_bot**. It only sends alerts and will **never** ask for your private key, seed phrase, login codes or a transfer of funds. Ignore any other account that claims to be Orbie.

### How do I turn alerts off or unlink Telegram?

Turn off the bell for a trader to stop their alerts; removing a trader from Favorites removes the alert too. To stop everything, unlink Telegram in Settings.

## Risks

### What are the risks of copy trading?

- **Past performance does not predict future results.** A trader at the top of the leaderboard can lose heavily next month.
- **Leverage and liquidation.** Perpetuals use leverage; a small move against a position can liquidate it and wipe out its margin.
- **Latency and slippage.** A copied order always comes after the trader's order and may fill at a worse price.
- **Traders change.** A trader may change strategy, raise leverage or trade from other accounts you can't see.
- **Technical and third-party risk.** Hyperliquid, Arbitrum, Privy, Telegram or Orbie itself can fail or pause.

Only commit money you can afford to lose entirely.

### What if a trader I copy loses money?

Your copied positions lose money too (in paper mode, the loss is in virtual funds). Orbie does not guarantee any profit and does not compensate trading losses. Consider spreading your copies, keeping amounts reasonable and checking performance regularly.

### Does Orbie give investment advice?

No. All data, rankings, scores and featured traders on Orbie are information only, not investment advice. Make your own decisions and consult a professional if needed.

## Contact

### How do I get in touch?

- Email: 【待填：contact email】
- X: [@orbie_fun](https://x.com/orbie_fun)
- 【待填：Telegram community or support channel】

Note: @orbie_fun_bot only sends alerts and does not handle support messages.
