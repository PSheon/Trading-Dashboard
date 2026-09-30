/**
 * Fixture watchlist data: favorites groups (mutable per tab) and watchlist
 * cards built from the fixture leaderboard, so the signed-in /favorites
 * page can be exercised without apps/api.
 */
import { FAVORITE_GROUP_COLORS, type FavoriteGroup, type TraderCard } from "@trading-dashboard/shared/contracts";

import { ApiError } from "@/lib/api";
import { findStats, initialFavorites, sparklineFor, traderStats } from "./data";

const COINS = [["BTC", "ETH", "SOL"], ["HYPE", "BTC"], ["ETH", "DOGE", "xyz:NVDA"], ["BTC"], ["SOL", "HYPE", "ZEC", "ETH"]];

let groups: FavoriteGroup[] = [
  { id: 1, name: "巨鯨", color: FAVORITE_GROUP_COLORS[0], sortOrder: 0, members: [initialFavorites[0], initialFavorites[2]], createdAt: new Date(Date.now() - 5 * 86400_000) },
  { id: 2, name: "短線", color: FAVORITE_GROUP_COLORS[1], sortOrder: 1, members: [initialFavorites[1]], createdAt: new Date(Date.now() - 4 * 86400_000) },
];
let nextId = 3;

export function listGroups(favorites: Set<string>): FavoriteGroup[] {
  return [...groups]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((g) => ({ ...g, members: g.members.filter((m) => favorites.has(m)) }));
}

function owned(id: number): FavoriteGroup {
  const group = groups.find((g) => g.id === id);
  if (!group) throw new ApiError(404, "Group not found");
  return group;
}

export function createGroup(input: { name: string; color?: string }): FavoriteGroup {
  const name = input.name.trim();
  if (groups.some((g) => g.name === name)) throw new ApiError(409, "A group with this name exists", { code: "group_exists" });
  if (groups.length >= 20) throw new ApiError(409, "At most 20 groups", { code: "group_limit", limit: 20 });
  const group: FavoriteGroup = {
    id: nextId++,
    name,
    color: input.color ?? FAVORITE_GROUP_COLORS[groups.length % FAVORITE_GROUP_COLORS.length],
    sortOrder: groups.reduce((m, g) => Math.max(m, g.sortOrder + 1), 0),
    members: [],
    createdAt: new Date(),
  };
  groups = [...groups, group];
  return group;
}

export function patchGroup(id: number, patch: { name?: string; color?: string; sortOrder?: number }): FavoriteGroup {
  const group = owned(id);
  const name = patch.name?.trim();
  if (name && name !== group.name && groups.some((g) => g.name === name)) throw new ApiError(409, "A group with this name exists", { code: "group_exists" });
  Object.assign(group, { ...(name ? { name } : {}), ...(patch.color ? { color: patch.color } : {}), ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}) });
  return group;
}

export function deleteGroup(id: number) {
  groups = groups.filter((g) => g.id !== id);
}

export function setMember(id: number, address: string, member: boolean, favorites: Set<string>): FavoriteGroup {
  const group = owned(id);
  if (member && !favorites.has(address)) throw new ApiError(404, `${address} is not a favorite`);
  group.members = member ? [...new Set([...group.members, address])] : group.members.filter((a) => a !== address);
  return group;
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
