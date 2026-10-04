"use client";

import type { AlertRule, Tier } from "@/lib/contracts";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";

const TIERS: Tier[] = ["A", "B", "C"];

export interface RulePatch {
  paramsJson: Record<string, unknown>;
  cooldownS: number;
  tiers: Tier[];
  enabled: boolean;
}

/** One alert rule: enable switch, params JSON, cooldown, tiers. Used for a
 * user's own rules (Settings) and the admin's default rules. */
export function RuleEditor({
  rule,
  onSave,
  saving,
  readOnly = false,
  error,
}: {
  rule: AlertRule;
  onSave: (patch: RulePatch) => void;
  saving: boolean;
  readOnly?: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const original = JSON.stringify(rule.paramsJson, null, 2);
  const [paramsText, setParamsText] = useState(original);
  const [paramsError, setParamsError] = useState<string>();
  const [cooldownS, setCooldownS] = useState(rule.cooldownS);
  const [tiers, setTiers] = useState<Tier[]>(rule.tiers);
  const [enabled, setEnabled] = useState(rule.enabled);

  const dirty =
    paramsText !== original ||
    cooldownS !== rule.cooldownS ||
    enabled !== rule.enabled ||
    [...tiers].sort().join() !== [...rule.tiers].sort().join();

  function save() {
    if (readOnly) return;
    let paramsJson: Record<string, unknown>;
    try {
      paramsJson = JSON.parse(paramsText) as Record<string, unknown>;
      setParamsError(undefined);
    } catch {
      setParamsError(t("admin.rules.paramsInvalid"));
      return;
    }
    onSave({ paramsJson, cooldownS, tiers, enabled });
  }

  return (
    <fieldset disabled={readOnly} aria-label={rule.kind} className="flex flex-col gap-4 rounded-2xl bg-raised/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-background px-2 py-1 font-mono text-sm font-bold text-primary-text">{rule.kind}</span>
          <span className="text-xs text-muted-foreground">{t(`admin.rules.scopes.${rule.scope}`)}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((e) => !e)}
          className="flex items-center gap-2 rounded-full text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={enabled ? "text-foreground" : "text-muted-foreground"}>
            {enabled ? t("common.enabled") : t("common.disabled")}
          </span>
          <span className={cn("relative h-5 w-9 rounded-full transition-colors", enabled ? "bg-primary" : "bg-border-strong")}>
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-foreground transition-[left]",
                enabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </span>
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`params-${rule.id}`}>{t("admin.rules.params")}</Label>
          <Textarea
            id={`params-${rule.id}`}
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={4}
            aria-invalid={paramsError ? true : undefined}
          />
          {paramsError ? <p className="text-xs text-negative">{paramsError}</p> : null}
        </div>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`cooldown-${rule.id}`}>{t("admin.rules.cooldown")}</Label>
            <Input
              id={`cooldown-${rule.id}`}
              type="number"
              min={0}
              value={cooldownS}
              onChange={(e) => setCooldownS(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("admin.rules.tiers")}</Label>
            <div className="flex gap-2">
              {TIERS.map((tier) => {
                const on = tiers.includes(tier);
                return (
                  <button
                    key={tier}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTiers((prev) => (on ? prev.filter((x) => x !== tier) : [...prev, tier]))}
                    className={cn(
                      "h-9 w-12 rounded-full text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tier}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {error ? <p className="mr-auto text-xs text-negative">{error}</p> : null}
        <Button size="sm" disabled={readOnly || !dirty || saving} onClick={save}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </fieldset>
  );
}
