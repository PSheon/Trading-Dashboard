// FIFO lot matching and positions for one (wallet, mint).
//
// All amounts are bigint: raw token units and lamports. A cost or proceeds
// split across pieces is divided proportionally with the remainder carried, so
// pieces always add back up to the original exactly.
//
// A position runs from the first acquisition while flat to the moment holdings
// return to zero (or to dust). It is the unit metrics count; lots are the
// accounting underneath.


// Holdings at or below this share of the position's peak count as flat.
export const DUST_RATIO = { num: 1n, den: 1000n };

export type EventKind = "buy" | "sell" | "transfer_in" | "transfer_out";

export interface FifoEvent {
  txSig: string;
  slot: number;
  blockTime: number;
  kind: EventKind;
  amount: bigint; // signed raw token amount
  sol: bigint | null; // buy: lamports paid incl. fees; sell: lamports received net of fees
}

export interface Lot {
  wallet: string;
  mint: string;
  lot_seq: number;
  position_seq: number;
  buy_tx_sig: string | null;
  buy_time: number | null;
  close_tx_sig: string | null;
  close_time: number | null;
  close_type: "sell" | "transfer_out" | "dust" | null; // null while open
  token_amount_raw: bigint;
  cost_lamports: bigint | null;
  proceeds_lamports: bigint | null;
  realized_pnl_lamports: bigint | null;
  hold_seconds: number | null;
  cost_unknown: boolean;
}

export interface Position {
  wallet: string;
  mint: string;
  position_seq: number;
  opened_at: number;
  closed_at: number | null;
  cost_lamports: bigint;
  proceeds_lamports: bigint;
  realized_pnl_lamports: bigint | null; // only for complete positions
  lots: number;
  has_unknown_cost: boolean;
  has_transfer_out: boolean;
  complete: boolean; // closed, every cost and proceeds known, nothing transferred away
}

interface OpenLot {
  amount: bigint;
  cost: bigint | null;
  buyTxSig: string;
  buyTime: number;
  costUnknown: boolean;
}

interface OpenPosition {
  seq: number;
  openedAt: number;
  held: bigint;
  peak: bigint;
  lots: Lot[];
}

// Floor division, so a negative amount (a sell whose fees exceed its proceeds)
// splits the same way every time; BigInt `/` truncates toward zero instead.
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

const share = (total: bigint | null, piece: bigint, whole: bigint) =>
  total === null ? null : floorDiv(total * piece, whole);

/** Events must already be in chain order: slot, then position in the block. */
export function runFifo(
  wallet: string,
  mint: string,
  events: readonly FifoEvent[],
  dust = DUST_RATIO,
): { lots: Lot[]; positions: Position[] } {
  const open: OpenLot[] = [];
  const lots: Lot[] = [];
  const positions: Position[] = [];
  let pos: OpenPosition | null = null;

  const close = (
    p: OpenPosition,
    o: OpenLot | null,
    piece: bigint,
    cost: bigint | null,
    proceeds: bigint | null,
    e: FifoEvent,
    closeType: "sell" | "transfer_out" | "dust",
  ) => {
    const costUnknown = o === null || o.costUnknown;
    let pnl: bigint | null = null;
    if ((closeType === "sell" || closeType === "dust") && !costUnknown && proceeds !== null && cost !== null) {
      pnl = proceeds - cost;
    }
    p.lots.push({
      wallet,
      mint,
      // One buy sold in pieces yields several lots, so number them as emitted.
      lot_seq: lots.length + p.lots.length,
      position_seq: p.seq,
      buy_tx_sig: o?.buyTxSig ?? null,
      buy_time: o?.buyTime ?? null,
      close_tx_sig: e.txSig,
      close_time: e.blockTime,
      close_type: closeType,
      token_amount_raw: piece,
      cost_lamports: cost,
      proceeds_lamports: proceeds,
      realized_pnl_lamports: pnl,
      hold_seconds: o ? e.blockTime - o.buyTime : null,
      cost_unknown: costUnknown,
    });
  };

  for (const e of events) {
    pos ??= { seq: positions.length, openedAt: e.blockTime, held: 0n, peak: 0n, lots: [] };

    if (e.amount > 0n) {
      const known = e.kind === "buy" && e.sol !== null;
      open.push({
        amount: e.amount,
        cost: known ? e.sol : null,
        buyTxSig: e.txSig,
        buyTime: e.blockTime,
        costUnknown: !known,
      });
      pos.held += e.amount;
      if (pos.held > pos.peak) pos.peak = pos.held;
    } else if (e.amount < 0n) {
      const closeType = e.kind === "sell" ? "sell" : "transfer_out";
      let remaining = -e.amount;
      let proceedsLeft = closeType === "sell" ? e.sol : null;
      while (remaining > 0n) {
        const o = open[0] ?? null;
        const piece = o ? (o.amount < remaining ? o.amount : remaining) : remaining;
        let cost: bigint | null = null;
        if (o) {
          cost = share(o.cost, piece, o.amount);
          o.cost = o.cost === null ? null : o.cost - cost!;
          o.amount -= piece;
          pos.held -= piece;
          if (o.amount === 0n) open.shift();
        }
        const proceeds = share(proceedsLeft, piece, remaining);
        if (proceedsLeft !== null) proceedsLeft -= proceeds!;
        remaining -= piece;
        close(pos, o, piece, cost, proceeds, e, closeType);
      }
    }

    if (pos.held * dust.den <= pos.peak * dust.num) {
      while (open.length) {
        const o = open.shift()!;
        close(pos, o, o.amount, o.cost, 0n, e, "dust");
      }
      lots.push(...pos.lots);
      positions.push(finish(wallet, mint, pos, e.blockTime));
      pos = null;
    }
  }

  if (pos) {
    for (const o of open) {
      pos.lots.push({
        wallet,
        mint,
        lot_seq: lots.length + pos.lots.length,
        position_seq: pos.seq,
        buy_tx_sig: o.buyTxSig,
        buy_time: o.buyTime,
        close_tx_sig: null,
        close_time: null,
        close_type: null,
        token_amount_raw: o.amount,
        cost_lamports: o.cost,
        proceeds_lamports: null,
        realized_pnl_lamports: null,
        hold_seconds: null,
        cost_unknown: o.costUnknown,
      });
    }
    lots.push(...pos.lots);
    positions.push(finish(wallet, mint, pos, null));
  }
  return { lots, positions };
}

function finish(wallet: string, mint: string, pos: OpenPosition, closedAt: number | null): Position {
  const closed = pos.lots.filter((l) => l.close_type !== null);
  const hasUnknownCost = pos.lots.some((l) => l.cost_unknown);
  const hasTransferOut = pos.lots.some((l) => l.close_type === "transfer_out");
  const complete =
    closedAt !== null && !hasUnknownCost && !hasTransferOut && closed.every((l) => l.realized_pnl_lamports !== null);
  return {
    wallet,
    mint,
    position_seq: pos.seq,
    opened_at: pos.openedAt,
    closed_at: closedAt,
    cost_lamports: pos.lots.reduce((s, l) => s + (l.cost_lamports ?? 0n), 0n),
    proceeds_lamports: closed.reduce((s, l) => s + (l.proceeds_lamports ?? 0n), 0n),
    realized_pnl_lamports: complete ? closed.reduce((s, l) => s + l.realized_pnl_lamports!, 0n) : null,
    lots: pos.lots.length,
    has_unknown_cost: hasUnknownCost,
    has_transfer_out: hasTransferOut,
    complete,
  };
}

interface TradeLike {
  wallet: string;
  mint: string;
  tx_sig: string;
  slot: number;
  tx_index: number | null;
  block_time: number;
  side: string;
  token_amount_raw: bigint;
  sol_lamports: bigint | null;
  fee_lamports: bigint;
}

interface TransferLike {
  wallet: string;
  mint: string;
  tx_sig: string;
  slot: number;
  tx_index: number | null;
  block_time: number;
  direction: string;
  token_amount_raw: bigint;
}

type Keyed = FifoEvent & { wallet: string; mint: string; txIndex: number | null };

/** Chain order: slot, then position in the block; tx_sig only breaks ties when
 *  the index is missing, so the order is at least reproducible. */
function chainOrder(a: Keyed, b: Keyed): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.txIndex !== b.txIndex) {
    if (a.txIndex === null) return 1;
    if (b.txIndex === null) return -1;
    return a.txIndex - b.txIndex;
  }
  return a.txSig < b.txSig ? -1 : a.txSig > b.txSig ? 1 : 0;
}

/** Lots and positions for every (wallet, mint) in the inputs. */
export function build(
  trades: readonly TradeLike[],
  transfers: readonly TransferLike[],
): { lots: Lot[]; positions: Position[] } {
  const groups = new Map<string, Keyed[]>();
  const push = (e: Keyed) => {
    const k = `${e.wallet}\u0000${e.mint}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  };
  for (const t of trades) {
    const buy = t.side === "buy";
    push({
      wallet: t.wallet,
      mint: t.mint,
      txSig: t.tx_sig,
      slot: t.slot,
      txIndex: t.tx_index,
      blockTime: t.block_time,
      kind: buy ? "buy" : "sell",
      amount: buy ? t.token_amount_raw : -t.token_amount_raw,
      sol: t.sol_lamports === null ? null : buy ? t.sol_lamports + t.fee_lamports : t.sol_lamports - t.fee_lamports,
    });
  }
  for (const x of transfers) {
    const inbound = x.direction === "in";
    push({
      wallet: x.wallet,
      mint: x.mint,
      txSig: x.tx_sig,
      slot: x.slot,
      txIndex: x.tx_index,
      blockTime: x.block_time,
      kind: inbound ? "transfer_in" : "transfer_out",
      amount: inbound ? x.token_amount_raw : -x.token_amount_raw,
      sol: null,
    });
  }
  const lots: Lot[] = [];
  const positions: Position[] = [];
  for (const key of [...groups.keys()].sort()) {
    const events = groups.get(key)!.sort(chainOrder);
    const r = runFifo(events[0].wallet, events[0].mint, events);
    lots.push(...r.lots);
    positions.push(...r.positions);
  }
  return { lots, positions };
}

