"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { tierEnum, type LeaderSummary } from "@trading-dashboard/shared";

import { api } from "@/lib/api";
import { formatDateTime, formatDuration, formatPct, formatUsd, leaderLabel } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SortKey = "rank" | "pnl7d" | "pnl30d" | "winRate" | "avgHoldTimeSeconds" | "lastActionAt";

function SortableHead({
  label,
  sortKeyName,
  sortKey,
  sortDesc,
  onSort,
}: {
  label: string;
  sortKeyName: SortKey;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
}) {
  return (
    <TableHead className="cursor-pointer text-right select-none" onClick={() => onSort(sortKeyName)}>
      {label}
      {sortKey === sortKeyName ? (sortDesc ? " ↓" : " ↑") : ""}
    </TableHead>
  );
}

/** D2 Leaders table: CopyDog rank, label, tier, open positions, 7d/30d
 * realized PnL, win rate, avg hold time, last action time. Sortable
 * (client-side, table is capped at ~100 rows) and filterable by tier/active. */
export default function LeadersPage() {
  const [tier, setTier] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("pnl30d");
  const [sortDesc, setSortDesc] = useState(true);

  const params = new URLSearchParams();
  if (tier) params.set("tier", tier);
  if (activeOnly) params.set("active", "true");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["leaders", tier, activeOnly],
    queryFn: () => api.get<LeaderSummary[]>(`/leaders?${params.toString()}`),
  });

  const sorted = useMemo(() => {
    if (!data) return [];
    const copy = [...data];
    const toComparable = (value: unknown): number => {
      if (value === null || value === undefined) return -Infinity;
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      // `lastActionAt` arrives over the wire as an ISO string, not a real
      // Date instance (no JSON revival step) — fall back to Date parsing
      // for anything that isn't already numeric.
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) return asNumber;
      const asDate = new Date(value as string).getTime();
      return Number.isFinite(asDate) ? asDate : -Infinity;
    };
    copy.sort((a, b) => {
      const an = toComparable(a[sortKey]);
      const bn = toComparable(b[sortKey]);
      return sortDesc ? bn - an : an - bn;
    });
    return copy;
  }, [data, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Leaders</h1>
        <p className="text-sm text-muted-foreground">
          CopyDog rank, tier, open positions, realized PnL, win rate, and activity per address.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="">All tiers</option>
            {tierEnum.map((t) => (
              <option key={t} value={t}>
                Tier {t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Active only
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading...</p> : null}
          {isError ? <p className="p-4 text-sm text-destructive">Failed to load leaders.</p> : null}
          {sorted.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Rank</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Open positions</TableHead>
                  <SortableHead label="7d PnL" sortKeyName="pnl7d" sortKey={sortKey} sortDesc={sortDesc} onSort={toggleSort} />
                  <SortableHead label="30d PnL" sortKeyName="pnl30d" sortKey={sortKey} sortDesc={sortDesc} onSort={toggleSort} />
                  <SortableHead label="Win rate" sortKeyName="winRate" sortKey={sortKey} sortDesc={sortDesc} onSort={toggleSort} />
                  <SortableHead label="Avg hold" sortKeyName="avgHoldTimeSeconds" sortKey={sortKey} sortDesc={sortDesc} onSort={toggleSort} />
                  <SortableHead label="Last action" sortKeyName="lastActionAt" sortKey={sortKey} sortDesc={sortDesc} onSort={toggleSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((leader) => (
                  <TableRow key={leader.address}>
                    <TableCell className="text-right">{leader.rank ?? "—"}</TableCell>
                    <TableCell>
                      <Link
                        href={`/leaders/${leader.address}`}
                        className="text-primary hover:underline"
                      >
                        {leaderLabel(leader)}
                      </Link>
                      {!leader.active ? (
                        <Badge variant="secondary" className="ml-2">
                          inactive
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{leader.tier}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{leader.openPositionCount}</TableCell>
                    <TableCell className={`text-right ${pnlColor(leader.pnl7d)}`}>{formatUsd(leader.pnl7d)}</TableCell>
                    <TableCell className={`text-right ${pnlColor(leader.pnl30d)}`}>{formatUsd(leader.pnl30d)}</TableCell>
                    <TableCell className="text-right">{formatPct(leader.winRate)}</TableCell>
                    <TableCell className="text-right">{formatDuration(leader.avgHoldTimeSeconds)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {leader.lastActionAt ? formatDateTime(leader.lastActionAt) : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {!isLoading && sorted.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No leaders match these filters.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-destructive";
  return "";
}
