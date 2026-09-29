"use client";

import { useQuery } from "@tanstack/react-query";
import type { HeartbeatResponse } from "@trading-dashboard/shared";

import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Bare system-status page: calls GET /health (§8 可觀測 heartbeat). */
export default function StatusPage() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HeartbeatResponse>("/health"),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          System status
        </h1>
        <p className="text-sm text-muted-foreground">
          Refreshes every 10s from GET /health. Times are Asia/Taipei.
        </p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Heartbeat</CardTitle>
          <CardDescription>
            {dataUpdatedAt
              ? `Last checked ${new Date(dataUpdatedAt).toLocaleTimeString("en-US", { timeZone: "Asia/Taipei" })} (Asia/Taipei)`
              : "Checking..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {isLoading ? <p>Loading...</p> : null}
          {isError ? (
            <p className="text-destructive">
              Could not reach the api: {(error as Error).message}
            </p>
          ) : null}
          {data ? (
            <>
              <Row
                label="Trade feed"
                value={
                  <Badge variant={data.feedConnected ? "default" : "destructive"}>
                    {data.feedConnected
                      ? `connected · ${data.marketsSubscribed} markets`
                      : `down${data.feedDisconnectedSince ? ` since ${taipei(data.feedDisconnectedSince)}` : ""} · ${data.feedSocketsOpen}/${data.feedSocketsTotal} sockets`}
                  </Badge>
                }
              />
              <Row label="Last trade seen" value={taipei(data.lastTradeAt)} />
              <Row label="Last fill stored" value={taipei(data.lastFillAt)} />
              <Row label="Last 5-min snapshot" value={taipei(data.lastSnapshotAt)} />
              <Row label="Last sweep" value={taipei(data.lastSweepAt)} />
              <Row
                label="REST (last minute)"
                value={`${data.requestsLastMinute} requests · ${data.weightLastMinute} weight · queued ${data.queuedRequests.live} live / ${data.queuedRequests.background} background`}
              />
              <Row
                label="Fills missing from Hyperliquid's API"
                value={
                  data.fillsUnavailable.length === 0 ? (
                    "none"
                  ) : (
                    <span className="flex flex-col items-end gap-1">
                      {data.fillsUnavailable.map((f) => (
                        <span key={f.address} className="font-mono text-xs">
                          {f.address.slice(0, 10)}… · {f.missedTrades} trades since {taipei(f.since)}
                        </span>
                      ))}
                    </span>
                  )
                }
              />
              <Row
                label="DRY_RUN"
                value={
                  <Badge variant={data.dryRun ? "outline" : "destructive"}>
                    {data.dryRun ? "on (notify logs only)" : "off"}
                  </Badge>
                }
              />
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function taipei(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString("en-US", { timeZone: "Asia/Taipei" })
    : "never";
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
