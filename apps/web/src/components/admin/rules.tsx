"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AlertRule, UpsertAlertRuleRequest } from "@trading-dashboard/shared";

import { ErrorState, Panel, Skeleton } from "@/components/page";
import { RuleEditor } from "@/components/rules/rule-editor";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";

/** Default rules (userId null), copied to each new user on first login. */
export function AdminRules() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["admin", "rules"],
    queryFn: () => api.get<AlertRule[]>("/alert-rules"),
    refetchInterval: false,
  });
  const save = useMutation<AlertRule, ApiError, UpsertAlertRuleRequest>({
    mutationFn: (body) => api.post<AlertRule>("/alert-rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "rules"] }),
  });

  return (
    <Panel className="p-5 md:p-6">
      <h2 className="text-base font-bold tracking-tight">{t("admin.rules.title")}</h2>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("admin.rules.hint")}</p>
      <div className="mt-5 flex flex-col gap-3">
        {rules.isError ? (
          <ErrorState message={rules.error.message} onRetry={() => rules.refetch()} />
        ) : !rules.data ? (
          <Skeleton className="h-48" />
        ) : rules.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.noRules")}</p>
        ) : (
          rules.data.map((rule) => (
            <RuleEditor
              key={`${rule.id}-${JSON.stringify(rule)}`}
              rule={rule}
              saving={save.isPending && save.variables?.id === rule.id}
              error={save.isError && save.variables?.id === rule.id ? save.error.message : undefined}
              onSave={(patch) =>
                save.mutate({
                  id: rule.id,
                  scope: rule.scope,
                  kind: rule.kind,
                  quietHours: rule.quietHours ?? null,
                  ...patch,
                })
              }
            />
          ))
        )}
      </div>
    </Panel>
  );
}
