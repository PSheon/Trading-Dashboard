# Recorded Hyperliquid info answers

`<network>/<date>/<type>[-<address prefix>][-<dex|coin|oid>].json`: what the public `POST /info` endpoint answered, as received, for the reads the live copy path makes about a leader and a follower; `index.json` lists each file's request body, time, size and (for the time-windowed lists) the window it covers. Recorded on 2026-10-23: four mainnet accounts chosen for their shapes (float-printed position sizes, zero-hash maker fills, a TWAP-only leader, spot and perp resting orders, an unknownOid status read). The whole set is under 1 MB.

**Re-record** (read only, no auth, no DB, never in CI):

    node scripts/ops/hl-record.mjs --network mainnet --address 0x… [--address 0x…] [--exclude our-accounts.txt] [--hours 24] [--max-fills 500]

A new date gets a new directory and `latestRecording()` picks it up; a second run on the same day merges into the day's `index.json`. A fills or TWAP list longer than `--max-fills` keeps its newest rows (re-serialised, flagged `truncated` in the index); nothing else is edited.

**Excluded**: nothing about our own follower accounts (list them in the `--exclude` file; the run refuses before any request), no exchange or signed calls, no WebSocket frames (the observer's `allDexsClearinghouseState` aggregate is composed in tests from the per-dex `clearinghouseState` files), `userFunding` is a 500-row page at most, and `meta`/`metaAndAssetCtxs` are the main dex only.

**How specs use it**: `test/support/recorded-hyperliquid-info.ts` — `recordedHyperliquidInfo(latestRecording('mainnet'))` gives a `fetcher: typeof fetch` for the live readers' constructor seam (source client, account observer, receipt reader, market resolver), `raw()` for a parsed answer and `accountSource()` for the observer; windowed lists are filtered to the requested window and any unrecorded request throws. `test/hyperliquid-recorded-shapes.spec.ts` runs every decoder over the recording and holds the property tests for the three incident shapes.
