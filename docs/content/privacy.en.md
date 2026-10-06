# Privacy Policy

Last updated: 2026-10-06

Orbie is a trader-analytics and copy-trading tool for Hyperliquid, run by a small team. This page explains, in plain words, what we collect, why, how long we keep it and what you can do about it. "We" means the Orbie team.

## The short version

- We only collect what the service needs to work. **We don't sell data, we don't run ads,** and we don't use third-party analytics or trackers.
- Sign-in is handled by Privy. **Your private keys never pass through us,** and we can't see them.
- Trades on Hyperliquid are public. Anyone can look them up, including us.
- You can unfavorite traders, turn off alerts, unlink Telegram or delete your account at any time.

## What we get when you sign in

Privy handles sign-in, with email, a Google account or a crypto wallet. Once you're in, we keep an account record with:

- your Privy user ID;
- your email address (only if you sign in with email or Google);
- the wallet address you signed in with, and the address of the embedded wallet Privy creates for you;
- your display name, language and account role (user or admin);
- when your account was created and when you last signed in.

We never get your password, your email login codes, or any private key or seed phrase.

## What using Orbie creates

- **Favorites and groups:** the trader addresses you favorite, the groups you make, and your alert settings for each trader (on or off, buys or sells, minimum size). Favorited addresses join our watch list so we can send alerts in real time.
- **Copies:** the copies you set up, with their orders, fills, positions and accounting. Paper copies use virtual USDC and never send a real order.
- **Testnet copies:** these place real orders on the Hyperliquid testnet with test funds, so we also keep each copy's dedicated wallet address, its authorization status, and its transfers and orders.
- **Invites:** your invite code. If you joined through someone's invite link, we record who invited you, which code was used and when it was linked. Your inviter's friends list shows only an ID, the join time and copy status, never your email.
- **Withdrawals:** when you withdraw from your main wallet, we record the amount, the destination address and the status, so we can track whether it arrived.

## Telegram

When you connect Telegram in Settings, we store:

- the chat ID of your conversation with @orbie_fun_bot, so we can send you alerts;
- your Telegram @username at the moment you connected, only to show which account is linked.

The one-time link code expires after 10 minutes, and we only store a hash of it, not the code itself.

The bot only sends alerts: trade alerts for traders you favorite, and copy notifications you've turned on. Apart from commands like `/start` and `/stop`, we don't keep anything you send it, and it can't answer support questions.

Every alert sent leaves a delivery record with the chat ID and the message text. We keep these for 30 days.

## Wallets: what's yours and what we can do

- **Your main (embedded) wallet** is created by Privy when you sign in, and it is your Hyperliquid account. Privy holds the private key, and you can export it in Settings. Orbie's servers can't get that key and can't move the money in your main wallet. Deposits and withdrawals are signed by you, in your browser.
- **Testnet copy wallets:** each testnet copy gets its own wallet. Privy creates it, you're the only owner, and you can export its key too.
- **The copy agent:** before a testnet copy starts, you sign an authorization for an "agent" that lasts 1 to 30 days (you choose). Until then, our servers can use the agent to place orders, close positions and cancel orders for that copy's wallet. Under Hyperliquid's rules, an agent can't transfer or withdraw funds. The agent's key also lives with Privy and is set so it can't be exported.
- **Getting money back:** when a copy stops, the money in its wallet can only go back to your own main wallet, never to another address. If you allowed the automatic return when you started the copy, Orbie's server sends it back for you, and it can't send it anywhere else; otherwise the return needs your signature.
- Copying with real funds (mainnet) isn't available.

## Cookies and browser storage

We set only four cookies of our own, all simple preferences, kept for up to a year:

- `locale`: your language;
- `theme`: light or dark, if you picked one (removed when you choose "system");
- `cjk-font`: notes that the Chinese font is already downloaded, so pages load faster next time;
- `announcement-dismissed`: the announcement you closed, so it stays closed.

Your browser's local storage (localStorage and sessionStorage) also holds:

- addresses you searched recently, and your share-card style;
- an invite code from a link you opened, kept for 30 days until you sign in;
- notes about steps in progress (invites, copies, deposits), so they can finish after a dropped connection. Some of these are named with your email or wallet address. They stay in your browser and are cleared when you sign out or close the tab.

Privy also stores sign-in data in your browser (cookies or localStorage) to keep you signed in.

## Analytics and tracking

- We don't use Google Analytics or anything like it, and we have no ads, tracking cookies or error-reporting service. Our fonts are served from our own site, not Google Fonts.
- That said, **Privy's sign-in component sends its own usage events back to Privy**: things like start-up, sign-in, wallet creation and signing results, tagged with a random ID. A few error events include a wallet address. This is built into Privy and we can't switch it off. See Privy's privacy policy for details.

## Server logs

- For each API request we log the method, route, status, timing and a request ID. **We don't log your IP, query parameters or request content,** and secrets such as keys and tokens are masked.
- To stop abuse, we rate-limit by IP. The count lives in server memory for one minute and is never written to the database. When someone is rate-limited, the warning keeps only the first part of the IP.
- When the server hits an error, the log includes the request path, which can contain a wallet address.
- When we drop a live-data connection that stopped reading, the log records that connection's IP.
- When you block the Telegram bot, the log records your chat ID.
- These logs live with our host, Railway, for as long as Railway keeps them. We don't send logs to any other service.

## Who else touches your data

We only work with the services Orbie needs to run:

- **Privy:** sign-in, the embedded wallet, keys for copy wallets and agents, and its own usage events.
- **Hyperliquid:** the exchange itself. Your trades, deposits and withdrawals happen there and are public.
- **Railway:** hosts the website, the API and the database. Everything on this page is stored there.
- **Telegram:** delivers alerts, so it sees your chat ID and the alert text.
- **Public Arbitrum RPC:** for deposits and balance checks, your browser and our servers talk to public Arbitrum nodes, which see the connecting IP and the wallet address.
- **WalletConnect and Coinbase Wallet:** their relays are involved only if you sign in with an outside wallet.
- **Cloudflare Turnstile:** Privy may use it as a bot check during sign-in.
- **AWS S3:** we may download historical trades from Hyperliquid's public archive on S3. That's download only, and no user data is ever uploaded.

Beyond that, we only hand over data when the law requires it. Each of these services handles data under its own privacy policy. Our servers and providers may be in a different country from you.

## How long we keep things

- **Account, favorites, alert settings, Telegram link, paper copies:** until you delete your account.
- **Alert delivery records, and finished notification and copy queue items:** deleted automatically after 30 days.
- **Trader position and equity snapshots:** deleted automatically after 90 days. This is public trader data.
- **Admin activity log:** deleted automatically after 1 year.
- **Account deletion records:** deleted automatically after 1 year. Each one holds only an account number, the time and a few counts (such as how many favorites), never an email or address.
- **Testnet copy, withdrawal and invite records:** kept while you have an account; once you delete it, kept anonymously and deleted automatically after 1 year (see "Deleting your account" below).
- **Keyed hashes of a deleted identity:** kept for 1 year after you delete your account, then deleted automatically (see below).
- **Public fills of watched addresses:** kept long term to calculate performance.
- **Server logs and backups:** kept according to our host Railway's settings. We haven't set a period of our own.

## Deleting your account

Go to Settings → Account → Delete account; the steps are on [Delete your Orbie account](/delete-account). A few things to know first:

- **Only things still in progress stop you:** a testnet copy that's running or paused, a copy that's stopping, a one-click setup whose deposit was sent, a deposit, return, withdrawal or referral reward claim still being confirmed, an order still being confirmed, or a copy account that still holds money, positions or orders. Having used testnet copies, withdrawn or invited people never stops you. Paper copies are simply deleted with the account; anything never sent is cancelled automatically.
- **What gets deleted:** your account details (email, wallet addresses, display name, language, Privy account ID), favorites and groups, alert settings, Telegram link and delivery records, paper copies, and invite codes nobody signed up with.
- **Financial records kept anonymously for 1 year:** testnet copies, orders and fills, deposits and returns, main-wallet withdrawals, invite relations and authorization records. They involve money and must be kept for legal and reconciliation reasons, so on deletion they're moved under an anonymous number and no longer point to your account, email, name or Telegram. They still hold what the money movements need: the wallet addresses involved (public on Hyperliquid anyway) and the Privy account ID that owns your copy wallets, so funds that arrive late can still be traced and returned. They're deleted together with that number after 1 year.
- **Keyed hashes kept for 1 year:** one hash each of your Privy account ID, email and wallet addresses, made with a key only our server holds. They can't be reversed and can't identify you directly; they're only used to recognise the same identity signing up again within the year. The new account works normally but can't bind an invite code, so nobody can farm invite rewards by deleting and signing up again. They're deleted automatically after 1 year.
- **What also stays:** the deletion record above (1 year), and your trades on Hyperliquid (public on-chain data that nobody can delete).
- **Your sign-in at Privy, your embedded wallet and your copy-account wallets stay too,** because your money is in them. Orbie's signing permission on those wallets (the automatic return) is removed when you delete, and no funds are moved. If you sign in the same way later, you'll get the same wallet back with a brand-new Orbie account. We recommend withdrawing or exporting your key before you delete.

## What you can do

- Unfavorite traders, turn off alerts or change your language at any time.
- Unlink Telegram in Settings, or send `/stop` to the bot to pause alerts.
- Delete your account.
- Ask for a copy of your data, or point out something that's wrong, by messaging us on X.

## Under 18

Orbie is for adults only: 18 or older, or the age of majority where you live if that's higher. If we find an account belonging to a minor, we'll delete it.

## Security

Traffic between the website and the API is encrypted. Keys are held by Privy, and our servers never see them. Still, no system is perfectly secure, so keep your sign-in and any exported key safe.

## Changes to this page

When the service changes, we'll update this page and the date at the top. Bigger changes will be announced on the site or on X.

## Contact

Questions? Find us on X: [@orbie_fun](https://x.com/orbie_fun). The Telegram bot, @orbie_fun_bot, only sends alerts and can't reply to messages.
