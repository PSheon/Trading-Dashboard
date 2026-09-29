import type { actions, alertRules, leaders } from "@trading-dashboard/shared";

type ActionRow = typeof actions.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;
type AlertRuleRow = typeof alertRules.$inferSelect;

const KIND_LABEL: Record<ActionRow["kind"], string> = {
  open: "開倉",
  add: "加倉",
  reduce: "減倉",
  close: "平倉",
  flip: "翻倉",
  liquidation: "清算",
};

const SIDE_LABEL: Record<string, string> = {
  long: "多",
  short: "空",
};

/** `leader.label`, falling back to a truncated address (N1: "地址標籤(leader.
 * label, fall back to a truncated address if no label)"). */
export function leaderDisplayLabel(leader: Pick<LeaderRow, "label" | "address">): string {
  if (leader.label) return leader.label;
  const addr = leader.address;
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatWinRate(winRate: number | null): string {
  if (winRate === null) return "n/a";
  return `${(winRate * 100).toFixed(0)}%`;
}

/**
 * Renders the N1 Telegram message body. Exact field list per §4.4 N1:
 * 地址標籤、動作、幣種、方向、名目、槓桿、均價、該地址近 30 天(該幣)勝率、
 * dashboard 詳情連結. `rules` is every rule that matched this one action
 * (plural — e.g. R1 and R3 can both match the same large `open`); the
 * caller (RulesService) groups simultaneously-firing rules by chat
 * destination and sends exactly one message per destination rather than
 * one per rule, so this always renders as a single combined message
 * listing every matched rule kind. The rule-kind prefix itself isn't an
 * explicit PRD field, but is harmless and documented as a judgment call
 * for Paul's own disambiguation.
 */
export function renderRuleMessage(params: {
  rules: Pick<AlertRuleRow, "kind">[];
  leader: Pick<LeaderRow, "label" | "address">;
  action: ActionRow;
  winRate30dForCoin: number | null;
  dashboardUrl: string;
}): string {
  const { rules, leader, action, winRate30dForCoin, dashboardUrl } = params;
  const label = leaderDisplayLabel(leader);
  const kindLabel = KIND_LABEL[action.kind] ?? action.kind;
  const sideLabel = SIDE_LABEL[action.side] ?? action.side;
  const notional = formatUsd(Number(action.notionalUsd));
  const leverage = action.leverage ? `${Number(action.leverage)}x` : "n/a";
  const avgPx = formatUsd(Number(action.avgPx));
  const winRate = formatWinRate(winRate30dForCoin);
  const ruleLabel = rules.map((r) => r.kind).join("+");

  return [
    `[${ruleLabel}] ${label} ${kindLabel}`,
    `幣種: ${action.coin}`,
    `方向: ${sideLabel}`,
    `名目: ${notional}`,
    `槓桿: ${leverage}`,
    `均價: ${avgPx}`,
    `近 30 天勝率 (${action.coin}): ${winRate}`,
    `詳情: ${dashboardUrl}`,
  ].join("\n");
}
