import type { HlUserFill } from "../src/hyperliquid/types.js";

/** Fill shapes for the storage tests: every key seen in the dev database and
 * the archive on 2026-10-02 (22 keys, 29 key sets), and shapes never seen
 * that the typed columns must still hand back unchanged. */
const base = {
  coin: "BTC", px: "64585.0", sz: "0.01234", side: "B", time: 1_790_900_000_123, startPosition: "0.0", dir: "Open Long",
  closedPnl: "0.0", hash: `0x${"ab12".repeat(16)}`, oid: 563_286_100_430, crossed: true, fee: "0.286272", tid: 1_125_899_772_024_236,
  feeToken: "USDC", twapId: null,
};
const as = (value: Record<string, unknown>) => value as unknown as HlUserFill;
const ADDRESS = `0x${"c8a7b4".repeat(6)}c8a7`;

export const SEEN_SHAPES: HlUserFill[] = [
  as(base),
  as({ ...base, tid: 2, cloid: "0x000000000000000000000000083bf56b" }),
  as({ ...base, tid: 3, builderFee: "0.000003", builder: "0x0c8d970c462726e014ad36f6c5a63e99db48a8e7", cloid: "0xffffa3d73ab796f2948fb23b9a077010" }),
  as({ ...base, tid: 4, coin: "xyz:ZM", deployerFee: "-0.000001", priorityGas: "0.00000001", feeToken: "USDH" }),
  as({ ...base, tid: 5, side: "A", dir: "Close Long", closedPnl: "-0.00000001", startPosition: "999999.96411132", crossed: false,
    liquidation: { liquidatedUser: ADDRESS, markPx: "0.000222", method: "market" } }),
  as({ ...base, tid: 6, dir: "Liquidated Cross Long", liquidation: { markPx: "3339.3", method: "backstop" } }),
  // A TWAP slice: all-zero hash, twapId set.
  as({ ...base, tid: 7, hash: `0x${"0".repeat(64)}`, twapId: 992_864, fee: "-0.0000000001" }),
  as({ ...base, tid: 8, coin: "@107", dir: "Buy", feeToken: "HYPE", px: "0.0", sz: "0.0000000013", startPosition: "-0.00001" }),
  as({ ...base, tid: 0, coin: "#0", dir: "Spot Dust Conversion", feeToken: "+2020", time: 1_691_974_194_594, oid: 0 }),
];

/** Decimal spellings: `numeric` reproduces the first group; the second is
 * kept as text in `extra`. Either way the string must come back as written. */
export const CANONICAL_DECIMALS = ["0", "0.0", "0.00", "1", "1.0", "1.50", "100", "100.000", "-0.5", "-12.340", "0.00000001", "99998.0",
  "123456789012345678901234567890.123456789012345678901234567890", "999999.96411132"];
export const ODD_DECIMALS = ["-0", "-0.0", "1e-7", "1E5", "+1", ".5", "5.", "007.1", " 1", "1 ", "", "NaN", "Infinity", "1_000", "0x10", "1,5",
  `1.${"0".repeat(80)}`];

export const UNSEEN_SHAPES: HlUserFill[] = [
  // Keys this code does not know, of every JSON type.
  as({ ...base, tid: 100, newField: "x", nested: { a: [1, "2", null, { b: false }], c: {} }, list: [], flag: false, nothing: null, count: 1.25 }),
  // Known keys in shapes no column reproduces.
  as({ ...base, tid: 101, hash: `0x${"AB".repeat(32)}`, cloid: "0xABCDEF", builder: "0xNOTHEX", oid: -1, side: "X", crossed: "yes", twapId: "7" }),
  as({ ...base, tid: 102, oid: 1.5, twapId: -1, coin: 7, dir: null, feeToken: ["USDC"], hash: null }),
  as({ ...base, tid: 103, liquidation: { markPx: 3339.3, method: "market" } }),
  as({ ...base, tid: 104, liquidation: { liquidatedUser: ADDRESS, markPx: "1.0", method: "market", extra: 1 } }),
  as({ ...base, tid: 105, liquidation: null, builderFee: null, cloid: null }),
  as({ ...base, tid: 106, liquidation: { liquidatedUser: ADDRESS.toUpperCase(), markPx: "1.0", method: "market" } }),
  // Keys missing altogether, including twapId (absent is not null).
  as({ tid: 107, time: 1_790_900_000_000 }),
  as({ coin: "ETH", px: "1.0", sz: "1.0", side: "A", time: 1, dir: "Sell", closedPnl: "0.0", hash: base.hash, oid: 1, crossed: false, fee: "0.0", tid: 108 }),
  as(JSON.parse(`{"tid":109,"time":5,"__proto__":{"polluted":true},"constructor":"c","toString":"t"}`)),
  ...CANONICAL_DECIMALS.map((value, index) => as({ ...base, tid: 200 + index, px: value, sz: value, startPosition: value, closedPnl: value, fee: value,
    builderFee: value, deployerFee: value, priorityGas: value, liquidation: { markPx: value, method: "market" } })),
  ...ODD_DECIMALS.map((value, index) => as({ ...base, tid: 300 + index, px: value, sz: value, startPosition: value, closedPnl: value, fee: value,
    builderFee: value, deployerFee: value, priorityGas: value, liquidation: { markPx: value, method: "market" } })),
];

export const ALL_SHAPES = [...SEEN_SHAPES, ...UNSEEN_SHAPES];
