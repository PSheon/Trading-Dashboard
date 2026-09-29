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
          Polls GET /health every 10s. Backed by real Watcher/Scheduler state
          once that work lands — for now the api returns honest defaults.
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
                label="WS connected"
                value={
                  <Badge variant={data.wsConnected ? "default" : "secondary"}>
                    {data.wsConnected ? "connected" : "disconnected"}
                  </Badge>
                }
              />
              <Row
                label="Last fill received"
                value={
                  data.lastFillAt
                    ? new Date(data.lastFillAt).toLocaleString()
                    : "never"
                }
              />
              <Row
                label="Requests today"
                value={data.requestsToday.toString()}
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
