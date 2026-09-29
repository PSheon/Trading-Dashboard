"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  tierEnum,
  type AlertEntry,
  type AlertRule,
  type Tier,
  type UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

import { ApiError, api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** D5: rules management (R1-R3 for now — enable/disable, inline edit of
 * params/cooldown/tiers) plus a filterable alerts log. Scoring (1h/4h/24h,
 * N3) is P1/M3 — left as a "coming soon" note. */
export default function AlertsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Rule configuration and the notification log.
        </p>
      </div>

      <RulesSection />
      <ScoringComingSoon />
      <AlertsLogSection />
    </div>
  );
}

function RulesSection() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["alert-rules"],
    queryFn: () => api.get<AlertRule[]>("/alert-rules"),
  });

  const upsertMutation = useMutation<AlertRule, ApiError, UpsertAlertRuleRequest>({
    mutationFn: (body) => api.post<AlertRule>("/alert-rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alert-rules"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>Enable/disable and edit params, cooldown, and tiers per rule.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {isError ? <p className="text-sm text-destructive">Failed to load rules.</p> : null}
        {data?.map((rule) => (
          <RuleEditor
            key={rule.id}
            rule={rule}
            onSave={(patch) => upsertMutation.mutate({ ...rule, ...patch })}
            saving={upsertMutation.isPending}
          />
        ))}
        {data && data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rules seeded yet — R1/R2/R3 are seeded automatically on api startup.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RuleEditor({
  rule,
  onSave,
  saving,
}: {
  rule: AlertRule;
  onSave: (patch: Partial<UpsertAlertRuleRequest>) => void;
  saving: boolean;
}) {
  const [paramsText, setParamsText] = useState(JSON.stringify(rule.paramsJson, null, 2));
  const [paramsError, setParamsError] = useState<string>();
  const [cooldownS, setCooldownS] = useState(rule.cooldownS);
  const [tiers, setTiers] = useState<Tier[]>(rule.tiers);
  const [enabled, setEnabled] = useState(rule.enabled);

  const dirty =
    paramsText !== JSON.stringify(rule.paramsJson, null, 2) ||
    cooldownS !== rule.cooldownS ||
    enabled !== rule.enabled ||
    tiers.join() !== rule.tiers.join();

  function toggleTier(t: Tier) {
    setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function handleSave() {
    let paramsJson: Record<string, unknown>;
    try {
      paramsJson = JSON.parse(paramsText);
      setParamsError(undefined);
    } catch {
      setParamsError("Invalid JSON");
      return;
    }
    onSave({ paramsJson, cooldownS, tiers, enabled });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{rule.kind}</span>
          <Badge variant="outline">{rule.scope}</Badge>
          <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "enabled" : "disabled"}</Badge>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEnabled((e) => !e)}>
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`params-${rule.id}`}>Params (JSON)</Label>
          <Textarea
            id={`params-${rule.id}`}
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={4}
          />
          {paramsError ? <p className="text-xs text-destructive">{paramsError}</p> : null}
        </div>
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`cooldown-${rule.id}`}>Cooldown (seconds)</Label>
            <Input
              id={`cooldown-${rule.id}`}
              type="number"
              min={0}
              value={cooldownS}
              onChange={(e) => setCooldownS(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Tiers</Label>
            <div className="flex gap-3">
              {tierEnum.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={tiers.includes(t)} onChange={() => toggleTier(t)} />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function ScoringComingSoon() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Rule scoring
          <span className="ml-2 text-sm font-normal text-muted-foreground">(N3)</span>
        </CardTitle>
        <CardDescription>
          Coming soon — 1h/4h/24h post-alert price change per rule. M3.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function AlertsLogSection() {
  const [ruleId, setRuleId] = useState("");
  const [address, setAddress] = useState("");
  const [coin, setCoin] = useState("");

  const { data: rules } = useQuery({
    queryKey: ["alert-rules"],
    queryFn: () => api.get<AlertRule[]>("/alert-rules"),
  });

  const params = new URLSearchParams();
  if (ruleId) params.set("ruleId", ruleId);
  if (address) params.set("address", address);
  if (coin) params.set("coin", coin.toUpperCase());
  params.set("limit", "100");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["alerts-log", ruleId, address, coin],
    queryFn: () => api.get<AlertEntry[]>(`/alerts?${params.toString()}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts log</CardTitle>
        <CardDescription>Every notification attempt (real or dry-run).</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
          >
            <option value="">All rules</option>
            {rules?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.kind}
              </option>
            ))}
          </select>
          <Input
            placeholder="Address"
            className="w-48"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Input
            placeholder="Coin"
            className="w-32"
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
          />
        </div>

        {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {isError ? <p className="text-sm text-destructive">Failed to load alerts.</p> : null}
        {data && data.length === 0 ? <p className="text-sm text-muted-foreground">No alerts logged yet.</p> : null}
        {data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Coin</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow key={String(a.id)}>
                  <TableCell className="text-muted-foreground">{formatDateTime(a.sentAt)}</TableCell>
                  <TableCell>{rules?.find((r) => r.id === a.ruleId)?.kind ?? a.ruleId}</TableCell>
                  <TableCell className="font-mono text-xs">{a.address ?? "—"}</TableCell>
                  <TableCell>{a.coin ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={a.sendStatus === "failed" ? "destructive" : a.sendStatus === "sent" ? "default" : "outline"}>
                      {a.sendStatus}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
