"use client";

import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  actionKindEnum,
  tierEnum,
  type ActionFeedItem,
  type Fill,
} from "@trading-dashboard/shared";

import { api } from "@/lib/api";
import { formatDateTime, formatNumber, formatUsd, leaderLabel } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const KIND_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  open: "default",
  add: "secondary",
  reduce: "outline",
  close: "outline",
  flip: "destructive",
  liquidation: "destructive",
};

/** D1 Live Feed: all-address actions timeline, newest first. Filters:
 * coin, action kind, tier (server-side, via the leaders join in
 * actions.service.ts). Each row expands to its constituent fills. */
export default function FeedPage() {
  const [coin, setCoin] = useState("");
  const [kind, setKind] = useState("");
  const [tier, setTier] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (coin) params.set("coin", coin.toUpperCase());
  if (kind) params.set("kind", kind);
  if (tier) params.set("tier", tier);
  params.set("limit", "100");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["actions-feed", coin, kind, tier],
    queryFn: () => api.get<ActionFeedItem[]>(`/actions?${params.toString()}`),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live Feed</h1>
        <p className="text-sm text-muted-foreground">
          All monitored addresses&apos; actions, newest first. Polls every 10s.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input
            placeholder="Coin (e.g. BTC)"
            className="w-40"
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
          />
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            {actionKindEnum.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading...</p> : null}
          {isError ? <p className="p-4 text-sm text-destructive">Failed to load feed.</p> : null}
          {data && data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No actions yet.</p>
          ) : null}
          {data && data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Coin</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Notional</TableHead>
                  <TableHead className="text-right">Leverage</TableHead>
                  <TableHead className="text-right">Avg px</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => {
                  const id = String(row.id);
                  const expanded = expandedId === id;
                  return (
                    <Fragment key={id}>
                      <TableRow
                        className="cursor-pointer"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : id)}
                      >
                        <TableCell className="text-muted-foreground">{formatDateTime(row.ts)}</TableCell>
                        <TableCell>{leaderLabel({ label: row.leaderLabel, address: row.address })}</TableCell>
                        <TableCell>{row.leaderTier ? <Badge variant="outline">{row.leaderTier}</Badge> : "—"}</TableCell>
                        <TableCell>{row.coin}</TableCell>
                        <TableCell>
                          <Badge variant={KIND_VARIANT[row.kind] ?? "outline"}>{row.kind}</Badge>
                        </TableCell>
                        <TableCell>{row.side}</TableCell>
                        <TableCell className="text-right">{formatUsd(row.notionalUsd)}</TableCell>
                        <TableCell className="text-right">
                          {row.leverage ? `${formatNumber(row.leverage, 1)}x` : "n/a"}
                        </TableCell>
                        <TableCell className="text-right">{formatUsd(row.avgPx)}</TableCell>
                      </TableRow>
                      {expanded ? <ExpandedFillsRow actionId={id} colSpan={9} /> : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function ExpandedFillsRow({ actionId, colSpan }: { actionId: string; colSpan: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["action-fills", actionId],
    queryFn: () => api.get<Fill[]>(`/actions/${actionId}/fills`),
  });

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={colSpan} className="whitespace-normal p-3">
        {isLoading ? <span className="text-xs text-muted-foreground">Loading fills...</span> : null}
        {data && data.length === 0 ? (
          <span className="text-xs text-muted-foreground">No fills recorded for this action.</span>
        ) : null}
        {data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Dir</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead className="text-right">Closed PnL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((fill, i) => (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{formatDateTime(fill.ts)}</TableCell>
                  <TableCell>{fill.dir}</TableCell>
                  <TableCell className="text-right">{formatUsd(fill.px)}</TableCell>
                  <TableCell className="text-right">{formatNumber(fill.sz, 4)}</TableCell>
                  <TableCell className="text-right">{formatUsd(fill.fee)}</TableCell>
                  <TableCell className="text-right">
                    {fill.closedPnl !== null && fill.closedPnl !== undefined ? formatUsd(fill.closedPnl) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
