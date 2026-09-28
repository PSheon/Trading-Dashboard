# P0: source verification

Decides, before any schema is fixed, what the spec's P0 row asks for: the trade
grain, whether PumpSwap and bonding-curve trades are covered, how multi-hop
routes show up, what 180 days of one wallet costs in Helius credits, and which
source wallet history comes from.

## Run

```sh
cp .env.example .env          # fill HELIUS_API_KEY and DUNE_API_KEY
uv sync

uv run python spikes/p0/pick_wallets.py    # Dune: list projects, sample 5 wallets
uv run python spikes/p0/fetch_helius.py    # Helius: 180 days per wallet, raw pages kept
uv run python spikes/p0/fetch_dune.py      # Dune: same wallets, last 30 days
uv run python spikes/p0/compare.py         # writes data/p0/report.md
```

`pick_wallets.py` prints the project names Dune uses. If `pumpdotfun` or
`pumpswap` is not among them it stops; pass the right names with `--curve` and
`--amm`. To check wallets of your own choosing, edit `data/p0/wallets.txt`
(one address per line, `#` starts a comment).

## Reading the report

- **Coverage**: trades present in both sources, only Helius, only Dune.
  Look up the samples on Solscan to see which side is right.
- **Amount agreement**: token amounts should match exactly. The SOL leg differs
  by design; Helius counts what left the wallet minus network fee, Jito tip and
  rent, so trading-bot fees paid by transfer are inside it.
- **Venues**: which programs the traded transactions touched. Anything beyond
  pump.fun and PumpSwap is a venue the spec now requires.
- **Cost**: credits spent per wallet and the extrapolation to 1,000 wallets.

Record the decisions in the spec's P0 row.
