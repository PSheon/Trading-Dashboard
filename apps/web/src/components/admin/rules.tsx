"use client";
import { queryKeys } from "@/lib/query-keys";
import { usePermission } from "@/lib/auth";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AlertRule, UpsertAlertRuleRequest } from "@/lib/contracts";

import { ErrorState, Panel, PanelSkeleton } from "@/components/page";
import { RuleEditor } from "@/components/rules/rule-editor";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";

/** Default rules (userId null): what admins are alerted on for imported
 * traders. Users set alerts on their favorites instead. */
export function AdminRules() {
  const canManage = usePermission("rules.manage");
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: queryKeys.admin.rules,
    queryFn: ({ signal }) => api.get<AlertRule[]>("/alert-rules", signal),
    refetchInterval: false,
  });
  const save = useMutation<AlertRule, ApiError, UpsertAlertRuleRequest>({
    mutationFn: (body) => api.post<AlertRule>("/alert-rules", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.rules }),
  });

  return (
    <Panel className="p-5 md:p-6">
      <h2 className="text-base font-bold">{t("admin.rules.title")}</h2>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("admin.rules.hint")}</p>
      <div className="mt-5 flex flex-col gap-3">
        {rules.isError ? (
          <ErrorState message={rules.error.message} onRetry={() => rules.refetch()} />
        ) : !rules.data ? (
          <PanelSkeleton fields={4} />
        ) : rules.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.rules.empty")}</p>
        ) : (
          rules.data.map((rule) => (
            <RuleEditor
              key={`${rule.id}-${JSON.stringify(rule)}`}
              rule={rule}
              readOnly={!canManage}
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
