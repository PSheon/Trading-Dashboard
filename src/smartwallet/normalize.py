"""Turn one raw Solana transaction into per-(tx, wallet, mint) net deltas.

This reads the transaction's own pre/post balances, not any parser's reading of
its instructions, so the result is the same whichever program or aggregator
routed the swap, and a multi-hop route collapses to what the wallet actually
gave and got.

Input is the `getTransaction` shape (`json` or `jsonParsed` encoding).
"""

from collections import defaultdict
from dataclasses import dataclass

from .constants import JITO_TIP_ACCOUNTS, QUOTE_MINTS, STABLE_MINTS, WSOL_MINT


@dataclass(frozen=True)
class Delta:
    tx_sig: str
    wallet: str
    mint: str
    # trade: the token moved one way and SOL or a stablecoin moved the other way
    # transfer: the token moved with nothing coming back
    # complex: more than one non-quote token moved; left for a later decision
    kind: str
    side: str | None
    token_amount_raw: int  # signed, from the wallet's point of view
    decimals: int
    quote_mint: str | None  # WSOL_MINT stands for SOL, wrapped or not
    quote_amount_raw: int | None  # signed; lamports when the quote is SOL
    fee_lamports: int  # network fee and Jito tip, when this wallet paid them
    rent_lamports: int  # parked in (+) or returned from (-) the wallet's token accounts
    slot: int
    block_time: int | None


def account_keys(raw: dict) -> list[str]:
    keys = raw["transaction"]["message"]["accountKeys"]
    if keys and isinstance(keys[0], dict):
        # jsonParsed already lists lookup-table addresses, in order.
        return [k["pubkey"] for k in keys]
    loaded = raw["meta"].get("loadedAddresses") or {}
    return [*keys, *loaded.get("writable", []), *loaded.get("readonly", [])]


def owner_deltas(raw: dict, mint: str) -> dict[str, int]:
    """Net change of `mint` per owner across the whole transaction."""
    meta = raw["meta"]
    out: dict[str, int] = defaultdict(int)
    for sign, balances in ((-1, meta.get("preTokenBalances")), (1, meta.get("postTokenBalances"))):
        for b in balances or []:
            if b["mint"] == mint and b.get("owner"):
                out[b["owner"]] += sign * int(b["uiTokenAmount"]["amount"])
    return {owner: d for owner, d in out.items() if d != 0}


def counterparty(raw: dict, wallet: str, mint: str, amount: int) -> str | None:
    """The owner whose change of `mint` is largest in the opposite direction."""
    others = [
        (o, d)
        for o, d in owner_deltas(raw, mint).items()
        if o != wallet and (d > 0) != (amount > 0)
    ]
    return max(others, key=lambda od: (abs(od[1]), od[0]))[0] if others else None


def wallet_deltas(raw: dict, wallet: str) -> list[Delta]:
    meta = raw["meta"]
    if meta.get("err") is not None:
        return []

    keys = account_keys(raw)
    pre, post = meta["preBalances"], meta["postBalances"]

    def lamport_delta(i: int) -> int:
        return post[i] - pre[i]

    # Token accounts the wallet owns, before or after. An account that did not
    # exist on one side counts as holding zero there.
    before = {b["accountIndex"]: b for b in meta.get("preTokenBalances") or []}
    after = {b["accountIndex"]: b for b in meta.get("postTokenBalances") or []}
    token_delta: dict[str, int] = defaultdict(int)
    decimals: dict[str, int] = {}
    rent = 0
    for i in before.keys() | after.keys():
        b, a = before.get(i), after.get(i)
        if wallet not in {x.get("owner") for x in (b, a) if x}:
            continue
        mint = (a or b)["mint"]
        amount = int((a or {}).get("uiTokenAmount", {}).get("amount", 0)) - int(
            (b or {}).get("uiTokenAmount", {}).get("amount", 0)
        )
        token_delta[mint] += amount
        decimals[mint] = (a or b)["uiTokenAmount"]["decimals"]
        # A WSOL account's lamports are its rent plus the wrapped SOL itself.
        rent += lamport_delta(i) - (amount if mint == WSOL_MINT else 0)

    in_keys = wallet in keys
    if not in_keys and not token_delta:
        return []

    is_payer = in_keys and keys[0] == wallet
    fee = 0
    if is_payer:
        fee = meta["fee"] + sum(
            max(lamport_delta(i), 0) for i, k in enumerate(keys) if k in JITO_TIP_ACCOUNTS
        )
    native = lamport_delta(keys.index(wallet)) if in_keys else 0
    swap_sol = native + token_delta.get(WSOL_MINT, 0) + fee + rent

    quotes = {WSOL_MINT: swap_sol} | {m: token_delta[m] for m in STABLE_MINTS if m in token_delta}
    movers = {m: d for m, d in token_delta.items() if m not in QUOTE_MINTS and d != 0}

    def row(mint: str, amount: int, kind: str, side=None, quote_mint=None, quote_amount=None):
        return Delta(
            tx_sig=raw["transaction"]["signatures"][0],
            wallet=wallet,
            mint=mint,
            kind=kind,
            side=side,
            token_amount_raw=amount,
            decimals=decimals[mint],
            quote_mint=quote_mint,
            quote_amount_raw=quote_amount,
            fee_lamports=fee,
            rent_lamports=rent,
            slot=raw["slot"],
            block_time=raw.get("blockTime"),
        )

    if len(movers) > 1:
        return [row(m, d, "complex") for m, d in sorted(movers.items())]
    if not movers:
        return []

    [(mint, amount)] = movers.items()
    # SOL first: a route through a stablecoin that ends in SOL is still a SOL trade.
    for quote_mint in (WSOL_MINT, *sorted(STABLE_MINTS)):
        q = quotes.get(quote_mint, 0)
        if q != 0 and (q > 0) != (amount > 0):
            side = "buy" if amount > 0 else "sell"
            return [row(mint, amount, "trade", side, quote_mint, q)]
    return [row(mint, amount, "transfer")]
