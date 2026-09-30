/**
 * Fixture watchlist data: favorites groups (mutable per tab) and watchlist
 * cards built from the fixture leaderboard, so the signed-in /favorites
 * page can be exercised without apps/api.
 */
import { FAVORITE_GROUP_COLORS, FAVORITE_GROUPS_MAX, type FavoriteGroup, type TraderCard } from "@trading-dashboard/shared/contracts";

import { ApiError } from "@/lib/api";
import { findStats, initialFavorites, sparklineFor, traderStats } from "./data";

const COINS = [["BTC", "ETH", "SOL"], ["HYPE", "BTC"], ["ETH", "DOGE", "xyz:NVDA"], ["BTC"], ["SOL", "HYPE", "ZEC", "ETH"]];

const seed = (): FavoriteGroup[] => [
  { id: 1, name: "巨鯨", color: FAVORITE_GROUP_COLORS[0], sortOrder: 0, addresses: [initialFavorites[0], initialFavorites[2]], createdAt: new Date(Date.now() - 5 * 86400_000).toISOString() },
  { id: 2, name: "短線", color: FAVORITE_GROUP_COLORS[1], sortOrder: 1, addresses: [initialFavorites[1]], createdAt: new Date(Date.now() - 4 * 86400_000).toISOString() },
];
let groups = seed();
let nextId = 3;

/** Like the api: ordered by sortOrder, then id. */
export function listGroups(): FavoriteGroup[] {
  return [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

function owned(id: number): FavoriteGroup {
  const group = groups.find((g) => g.id === id);
  if (!group) throw new ApiError(404, "Group not found");
  return group;
}

const taken = (name: string, except?: number) => groups.some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());

export function createGroup(input: { name: string; color?: string }): FavoriteGroup {
  const name = input.name.trim();
  if (groups.length >= FAVORITE_GROUPS_MAX) throw new ApiError(409, `Up to ${FAVORITE_GROUPS_MAX} groups per user`, { code: "group_limit", limit: FAVORITE_GROUPS_MAX });
  if (taken(name)) throw new ApiError(409, "Group name already exists", { code: "group_name_exists" });
  const group: FavoriteGroup = {
    id: nextId++,
    name,
    color: input.color ?? FAVORITE_GROUP_COLORS[groups.length % FAVORITE_GROUP_COLORS.length],
    sortOrder: groups.reduce((m, g) => Math.max(m, g.sortOrder + 1), 0),
    addresses: [],
    createdAt: new Date().toISOString(),
  };
  groups = [...groups, group];
  return group;
}

export function patchGroup(id: number, patch: { name?: string; color?: string; sortOrder?: number }): FavoriteGroup {
  const group = owned(id);
  const name = patch.name?.trim();
  if (name && taken(name, id)) throw new ApiError(409, "Group name already exists", { code: "group_name_exists" });
  Object.assign(group, { ...(name ? { name } : {}), ...(patch.color ? { color: patch.color } : {}), ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}) });
  return group;
}

export function deleteGroup(id: number) {
  owned(id);
  groups = groups.filter((g) => g.id !== id);
}

/** Idempotent; the address must be a favorite. */
export function setMember(id: number, address: string, member: boolean, favorites: Set<string>) {
  const group = owned(id);
  if (!favorites.has(address)) throw new ApiError(404, "Favorite not found");
  group.addresses = member ? [...new Set([...group.addresses, address])] : group.addresses.filter((a) => a !== address);
}

/** Unfavoriting drops the trader from every group (the api's FK cascade). */
export function dropMember(address: string) {
  for (const group of groups) group.addresses = group.addresses.filter((a) => a !== address);
}

/** Account deletion forgets the demo groups. */
export function resetGroups() {
  groups = [];
}

/** A card per address: the fixture leaderboard's figures plus stable
 * made-up copy score, win rate and risk figures. */
export function traderCards(addresses: string[]): TraderCard[] {
  return addresses.map((address) => {
    const stats = findStats(address);
    const i = Math.max(0, traderStats.findIndex((s) => s.address === address));
    const spark = sparklineFor(address, "allTime").map((p) => p[1]);
    return {
      address,
      displayName: stats?.displayName ?? null,
      avatarUrl: null,
      xHandle: null,
      verified: false,
      kol: false,
      accountValue: stats?.accountValue ?? null,
      pnl: stats?.pnl.allTime ?? null,
      roi: stats?.roi.allTime ?? null,
      copyScore: stats ? 55 + ((i * 7) % 43) : null,
      style: null,
      topCoins: COINS[i % COINS.length],
      lastTradeAt: new Date(Date.now() - ((i % 5) + 1) * 3 * 3_600_000),
      sparkline: spark,
      pnl30d: stats?.pnl.month ?? null,
      winRate: stats ? 0.38 + ((i * 3) % 30) / 100 : null,
      sharpe: stats ? 0.8 + ((i * 13) % 30) / 10 : null,
      maxDrawdown: stats ? 0.08 + ((i * 11) % 25) / 100 : null,
      source: stats ? "pool" : "none",
    };
  });
}
