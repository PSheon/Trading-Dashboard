from smartwallet.constants import JITO_TIP_ACCOUNTS, USDC_MINT, WSOL_MINT
from smartwallet.normalize import account_keys, wallet_deltas

W = "Wallet1111111111111111111111111111111111111"
OTHER = "Other11111111111111111111111111111111111111"
MINT = "Mint111111111111111111111111111111111111111"
MINT_B = "MintB11111111111111111111111111111111111111"
ATA = "Ata1111111111111111111111111111111111111111"
ATA_B = "AtaB111111111111111111111111111111111111111"
WSOL_ACC = "WsolAcc111111111111111111111111111111111111"
USDC_ACC = "UsdcAcc111111111111111111111111111111111111"
OTHER_ATA = "OtherAta11111111111111111111111111111111111"
POOL = "Pool111111111111111111111111111111111111111"
TIP = sorted(JITO_TIP_ACCOUNTS)[0]

SOL = 1_000_000_000
RENT = 2_039_280
FEE = 5_000


def tx(keys, pre, post, pre_tok=(), post_tok=(), fee=FEE, err=None, loaded=None):
    return {
        "slot": 100,
        "blockTime": 1_700_000_000,
        "meta": {
            "err": err,
            "fee": fee,
            "preBalances": pre,
            "postBalances": post,
            "preTokenBalances": list(pre_tok),
            "postTokenBalances": list(post_tok),
            "loadedAddresses": loaded or {"writable": [], "readonly": []},
        },
        "transaction": {"signatures": ["sig1"], "message": {"accountKeys": keys}},
    }


def tb(index, mint, owner, amount, decimals=6):
    return {
        "accountIndex": index,
        "mint": mint,
        "owner": owner,
        "uiTokenAmount": {"amount": str(amount), "decimals": decimals},
    }


def test_buy_with_new_token_account_splits_swap_fee_and_rent():
    raw = tx(
        keys=[W, ATA, POOL],
        pre=[10 * SOL, 0, 50 * SOL],
        post=[10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL],
        post_tok=[tb(1, MINT, W, 1000)],
    )
    [d] = wallet_deltas(raw, W)
    assert (d.kind, d.side, d.mint) == ("trade", "buy", MINT)
    assert d.token_amount_raw == 1000
    assert d.decimals == 6
    assert (d.quote_mint, d.quote_amount_raw) == (WSOL_MINT, -SOL)
    assert d.fee_lamports == FEE
    assert d.rent_lamports == RENT
    assert (d.tx_sig, d.wallet, d.slot, d.block_time) == ("sig1", W, 100, 1_700_000_000)


def test_sell_into_existing_wsol_account_counts_wsol_as_sol():
    raw = tx(
        keys=[W, ATA, WSOL_ACC, POOL],
        pre=[SOL, RENT, RENT, 50 * SOL],
        post=[SOL - FEE, RENT, RENT + SOL // 2, 50 * SOL - SOL // 2],
        pre_tok=[tb(1, MINT, W, 1000), tb(2, WSOL_MINT, W, 0, 9)],
        post_tok=[tb(1, MINT, W, 0), tb(2, WSOL_MINT, W, SOL // 2, 9)],
    )
    [d] = wallet_deltas(raw, W)
    assert (d.kind, d.side, d.token_amount_raw) == ("trade", "sell", -1000)
    assert d.quote_amount_raw == SOL // 2
    assert d.rent_lamports == 0


def test_sell_that_closes_token_account_returns_rent_outside_the_swap():
    raw = tx(
        keys=[W, ATA, POOL],
        pre=[SOL, RENT, 50 * SOL],
        post=[SOL + SOL // 2 + RENT - FEE, 0, 50 * SOL - SOL // 2],
        pre_tok=[tb(1, MINT, W, 1000)],
    )
    [d] = wallet_deltas(raw, W)
    assert (d.side, d.token_amount_raw, d.quote_amount_raw) == ("sell", -1000, SOL // 2)
    assert d.rent_lamports == -RENT


def test_token_moving_without_opposite_quote_is_a_transfer_on_both_sides():
    raw = tx(
        keys=[W, ATA, OTHER_ATA],
        pre=[SOL, RENT, RENT],
        post=[SOL - FEE, RENT, RENT],
        pre_tok=[tb(1, MINT, W, 1000), tb(2, MINT, OTHER, 0)],
        post_tok=[tb(1, MINT, W, 0), tb(2, MINT, OTHER, 1000)],
    )
    [out] = wallet_deltas(raw, W)
    assert (out.kind, out.side, out.token_amount_raw, out.quote_mint) == (
        "transfer",
        None,
        -1000,
        None,
    )
    # The receiver is not in the account keys at all; it is found through the owner field.
    [inn] = wallet_deltas(raw, OTHER)
    assert (inn.kind, inn.token_amount_raw, inn.fee_lamports) == ("transfer", 1000, 0)


def test_transfer_out_that_pays_for_receivers_token_account_is_still_a_transfer():
    raw = tx(
        keys=[W, ATA, OTHER_ATA],
        pre=[SOL, RENT, 0],
        post=[SOL - FEE - RENT, RENT, RENT],
        pre_tok=[tb(1, MINT, W, 1000)],
        post_tok=[tb(1, MINT, W, 0), tb(2, MINT, OTHER, 1000)],
    )
    [d] = wallet_deltas(raw, W)
    assert d.kind == "transfer"


def test_jito_tip_paid_by_wallet_is_a_fee_not_swap_cost():
    tip = 1_000_000
    raw = tx(
        keys=[W, ATA, POOL, TIP],
        pre=[10 * SOL, 0, 50 * SOL, 0],
        post=[10 * SOL - SOL - FEE - RENT - tip, RENT, 51 * SOL, tip],
        post_tok=[tb(1, MINT, W, 1000)],
    )
    [d] = wallet_deltas(raw, W)
    assert d.quote_amount_raw == -SOL
    assert d.fee_lamports == FEE + tip


def test_tip_account_loaded_from_lookup_table_is_resolved():
    tip = 1_000_000
    raw = tx(
        keys=[W, ATA, POOL],
        pre=[10 * SOL, 0, 50 * SOL, 0],
        post=[10 * SOL - SOL - FEE - RENT - tip, RENT, 51 * SOL, tip],
        post_tok=[tb(1, MINT, W, 1000)],
        loaded={"writable": [TIP], "readonly": []},
    )
    assert account_keys(raw) == [W, ATA, POOL, TIP]
    [d] = wallet_deltas(raw, W)
    assert d.fee_lamports == FEE + tip


def test_json_parsed_account_keys_already_include_loaded_addresses():
    raw = tx(
        keys=[
            {"pubkey": W, "signer": True, "writable": True, "source": "transaction"},
            {"pubkey": TIP, "signer": False, "writable": True, "source": "lookupTable"},
        ],
        pre=[SOL, 0],
        post=[SOL, 0],
        loaded={"writable": [TIP], "readonly": []},
    )
    assert account_keys(raw) == [W, TIP]


def test_failed_transaction_produces_nothing():
    raw = tx(
        keys=[W, ATA],
        pre=[SOL, 0],
        post=[SOL - FEE, 0],
        err={"InstructionError": [0, "Custom"]},
    )
    assert wallet_deltas(raw, W) == []


def test_stablecoin_quote_keeps_stable_amount_and_mint():
    raw = tx(
        keys=[W, ATA, USDC_ACC, POOL],
        pre=[SOL, RENT, RENT, 0],
        post=[SOL - FEE, RENT, RENT, 0],
        pre_tok=[tb(1, MINT, W, 0), tb(2, USDC_MINT, W, 50_000_000)],
        post_tok=[tb(1, MINT, W, 1000), tb(2, USDC_MINT, W, 30_000_000)],
    )
    [d] = wallet_deltas(raw, W)
    assert (d.kind, d.side) == ("trade", "buy")
    assert (d.quote_mint, d.quote_amount_raw) == (USDC_MINT, -20_000_000)


def test_two_non_quote_mints_in_one_transaction_are_complex():
    raw = tx(
        keys=[W, ATA, ATA_B, POOL],
        pre=[SOL, RENT, RENT, 0],
        post=[SOL - FEE, RENT, RENT, 0],
        pre_tok=[tb(1, MINT, W, 1000), tb(2, MINT_B, W, 0)],
        post_tok=[tb(1, MINT, W, 0), tb(2, MINT_B, W, 500)],
    )
    deltas = wallet_deltas(raw, W)
    assert {d.mint: (d.kind, d.token_amount_raw) for d in deltas} == {
        MINT: ("complex", -1000),
        MINT_B: ("complex", 500),
    }


def test_wallet_absent_from_transaction_produces_nothing():
    raw = tx(keys=[OTHER, ATA], pre=[SOL, 0], post=[SOL - FEE, 0])
    assert wallet_deltas(raw, W) == []
