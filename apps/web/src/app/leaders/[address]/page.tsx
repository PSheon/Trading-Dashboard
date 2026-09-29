"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { LeaderDetailResponse } from "@trading-dashboard/shared";

import { api } from "@/lib/api";
import { formatDateTime, formatNumber, formatPct, formatUsd, leaderLabel } from "@/lib/format";
import { EquityCurveChart } from "@/components/equity-curve-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const CHAIN = "hyperliquid";

/** D3 Leader detail: current positions, fill history, self-stored equity
 * curve (hour/5m toggle), coin distribution, and this address's alert
 * history. */
export default function LeaderDetailPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const [equityInterval, setEquityInterval] = useState<"hour" | "5m">("hour");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["leader-detail", address, equityInterval],
    queryFn: () =>
      api.get<LeaderDetailResponse>(
        `/leaders/${CHAIN}/${address}?equityInterval=${equityInterval}`,
      ),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">Failed to load this leader.</p>;
  }

  const { leader, rank, positions, fills, equityCurve, coinDistribution, alerts, winRate } = data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{leaderLabel(leader)}</h1>
        <Badge variant="outline">Tier {leader.tier}</Badge>
        {!leader.active ? <Badge variant="secondary">inactive</Badge> : null}
        {rank ? <Badge variant="secondary">CopyDog #{rank}</Badge> : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">{leader.address}</p>

      <div className="grid gap-4 md:grid-cols-3">
        <SummaryTile label="Open positions" value={positions.length.toString()} />
        <SummaryTile label="30d win rate" value={formatPct(winRate)} />
        <SummaryTile label="First seen" value={formatDateTime(leader.firstSeenAt)} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Current positions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {positions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No open positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coin</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Entry px</TableHead>
                  <TableHead className="text-right">Leverage</TableHead>
                  <TableHead className="text-right">Unrealized PnL</TableHead>
                  <TableHead className="text-right">Liq. px</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.coin}>
                    <TableCell>{p.coin}</TableCell>
                    <TableCell className="text-right">{formatNumber(p.szi, 4)}</TableCell>
                    <TableCell className="text-right">{formatUsd(p.entryPx)}</TableCell>
                    <TableCell className="text-right">
                      {p.leverage ? `${formatNumber(p.leverage, 1)}x` : "n/a"}
                    </TableCell>
                    <TableCell className={`text-right ${Number(p.unrealizedPnl) >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {formatUsd(p.unrealizedPnl)}
                    </TableCell>
                    <TableCell className="text-right">{formatUsd(p.liqPx)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Equity curve</CardTitle>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={equityInterval === "hour" ? "secondary" : "ghost"}
                onClick={() => setEquityInterval("hour")}
              >
                Hourly
              </Button>
              <Button
                size="sm"
                variant={equityInterval === "5m" ? "secondary" : "ghost"}
                onClick={() => setEquityInterval("5m")}
              >
                5-minute
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <EquityCurveChart points={equityCurve} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coin distribution</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {coinDistribution.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open exposure.</p>
            ) : (
              coinDistribution
                .sort((a, b) => b.notionalUsd - a.notionalUsd)
                .map((entry) => (
                  <div key={entry.coin} className="flex flex-col gap-1">
                    <div className="flex justify-between text-sm">
                      <span>{entry.coin}</span>
                      <span className="text-muted-foreground">{formatPct(entry.shareOfTotal)}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(2, entry.shareOfTotal * 100)}%` }}
                      />
                    </div>
                  </div>
                ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Fill history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {fills.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No fills recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Coin</TableHead>
                  <TableHead>Dir</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Closed PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fills.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">{formatDateTime(f.ts)}</TableCell>
                    <TableCell>{f.coin}</TableCell>
                    <TableCell>{f.dir}</TableCell>
                    <TableCell className="text-right">{formatUsd(f.px)}</TableCell>
                    <TableCell className="text-right">{formatNumber(f.sz, 4)}</TableCell>
                    <TableCell className="text-right">
                      {f.closedPnl !== null && f.closedPnl !== undefined ? formatUsd(f.closedPnl) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alert history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {alerts.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No alerts triggered by this address yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Coin</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((a) => (
                  <TableRow key={String(a.id)}>
                    <TableCell className="text-muted-foreground">{formatDateTime(a.sentAt)}</TableCell>
                    <TableCell>{a.coin ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={a.sendStatus === "failed" ? "destructive" : "outline"}>{a.sendStatus}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Separator />
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-lg font-semibold">{value}</span>
      </CardContent>
    </Card>
  );
}
