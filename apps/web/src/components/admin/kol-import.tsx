"use client";
import { useSaveToast } from "@/lib/use-action-toast";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { KolPreview, KolInput } from "@/lib/contracts";
import { api, type ApiError } from "@/lib/api";
import { useImportKols } from "@/lib/admin-kols";
import { apiErrorKey } from "@/lib/api-error-text";
import { useI18n } from "@/i18n/provider";
import { Panel } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
const fields = [
  "displayName",
  "xHandle",
  "avatarUrl",
  "verified",
  "sortOrder",
] as const;
const labels = {
  displayName: "name",
  xHandle: "xHandle",
  avatarUrl: "avatar",
  verified: "verified",
  sortOrder: "order",
} as const;
export function KolImportPanel({
  registryRevision, registryReady,
}: {
  registryRevision: string; registryReady:boolean;
}) {
  const { t } = useI18n();
  const readId = useRef(0);
  const [csv, setCsv] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const saved = useSaveToast();
  const preview = useMutation<
    KolPreview,
    ApiError,
    { csv: string; replace: boolean; revision: string }
  >({
    mutationFn: ({ csv, replace }) =>
      api.post("/admin/kols/import/preview", { csv, replace }),
  });
  const commit = useImportKols();
  const reviewed =
    preview.isSuccess &&
    preview.variables?.csv === csv &&
    preview.variables.replace === replace &&
    preview.variables.revision === registryRevision;
  const ready =
    registryReady && reviewed &&
    preview.data?.canImport &&
    (!preview.data.removed || confirmRemoval);
  const reset = () => {
    preview.reset();
    setConfirmRemoval(false);
    commit.reset();
  };
  return (
    <Panel className="flex min-w-0 flex-col gap-4 p-5 md:p-6">
      <div>
        <h2 className="font-bold">{t("admin.kols.importTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("kolReview.hint")}
        </p>
      </div>
      <Input
        type="file"
        accept=".csv,text/csv"
        aria-label={t("admin.file")}
        disabled={commit.isPending}
        onChange={async (e) => {
          const id = ++readId.current;
          const file = e.target.files?.[0];
          setCsv(null);
          setFileError(null);
          reset();
          if (!file) return;
          try {
            if (file.size > 100 * 1024)
              throw new Error(t("importOps.tooLarge"));
            const text = await file.text();
            if (id === readId.current) setCsv(text);
          } catch (error) {
            if (id === readId.current)
              setFileError(
                error instanceof Error ? error.message : t("admin.parseFailed"),
              );
          }
        }}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={replace}
          disabled={commit.isPending}
          onChange={(e) => {
            setReplace(e.target.checked);
            reset();
          }}
        />
        {t("kolReview.replace")}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={preview.isPending} disabled={!(preview.isPending) && (!registryReady || !csv || preview.isPending || commit.isPending)}
          onClick={() => {
            setConfirmRemoval(false);
            preview.mutate({ csv: csv!, replace, revision: registryRevision });
          }}
        >
          {t("kolReview.preview")}
        </Button>
        <Button
          loading={commit.isPending} disabled={!(commit.isPending) && (!ready || commit.isPending || preview.isPending)}
          onClick={() =>
            commit.mutate(
              { csv: csv!, replace },
              saved({
                error: false,
                onSuccess: () => {
                  preview.reset();
                  setConfirmRemoval(false);
                },
              }),
            )
          }
        >
          {t("kolReview.confirm")}
        </Button>
      </div>
      {preview.isSuccess&&!reviewed&&<p role="status" className="text-sm text-warning">{t('kolReview.stale')}</p>}
      {fileError && (
        <p role="alert" className="text-sm text-negative">
          {fileError}
        </p>
      )}
      {preview.isError && (
        <p role="alert" className="text-sm text-negative">
          {preview.error.message}
        </p>
      )}
      {reviewed && preview.data && (
        <>
          <KolReview data={preview.data} />
          {preview.data.removed > 0 && (
            <label className="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-sm">
              <input
                type="checkbox"
                checked={confirmRemoval}
                disabled={commit.isPending}
                onChange={(e) => setConfirmRemoval(e.target.checked)}
              />
              {t("kolReview.removeConfirm", { count: preview.data.removed })}
            </label>
          )}
        </>
      )}
      {commit.isError && (
        <p role="alert" className="text-sm text-negative">
          {t(apiErrorKey(commit.error))}
        </p>
      )}
      {commit.data && (
        <div role="status" className="space-y-2 text-sm">
          <p>
            {t("admin.kols.imported", {
              inserted: String(commit.data.inserted),
              updated: String(commit.data.updated),
              removed: String(commit.data.removed),
            })}
          </p>
          {commit.data.errors.slice(0, 100).map((e) => (
            <p key={e.line}>
              {t("admin.kols.lineError", {
                line: String(e.line),
                message: e.message,
              })}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}
function KolReview({ data: d }: { data: KolPreview }) {
  const { t, format } = useI18n();
  const counts = [
    ["new", d.inserted],
    ["update", d.changed],
    ["unchanged", d.unchanged],
    ["remove", d.removed],
    ["duplicates", d.duplicateRows],
    ["errors", d.errorCount],
  ] as const;
  const value = (v: KolInput[keyof KolInput] | undefined) =>
    v === null || v === undefined
      ? t("kolReview.empty")
      : typeof v === "boolean"
        ? t(v ? "adminTrader.yes" : "adminTrader.no")
        : String(v);
  return (
    <section
      aria-label={t("kolReview.title")}
      className="space-y-3 border-t-2 border-dotted border-border pt-4"
    >
      <h3 className="type-h2">{t("kolReview.title")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("kolReview.snapshot")} {format.dateTime(d.sampledAt)}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {counts.map(([key, count]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(`kolReview.${key}`)}</dt>
            <dd className="font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
      {d.deletionsSuppressed && (
        <p role="status" className="text-sm text-warning">
          {t("kolReview.suppressed")}
        </p>
      )}
      {!d.canImport && <p className="text-sm">{t("kolReview.noChanges")}</p>}
      <p className="text-xs text-muted-foreground">{t("kolReview.rules")}</p>
      {d.errors.length > 0 && (
        <ul tabIndex={0} aria-label={t("kolReview.errors")} className="max-h-40 overflow-auto text-xs text-negative focus-visible:outline-2 focus-visible:outline-ring">
          {d.errors.map((e) => (
            <li key={e.line}>
              {t("admin.kols.lineError", {
                line: String(e.line),
                message: e.message,
              })}
            </li>
          ))}
        </ul>
      )}
      <ul tabIndex={0} aria-label={t("kolReview.title")} className="max-h-[32rem] space-y-3 overflow-y-auto focus-visible:outline-2 focus-visible:outline-ring">
        {d.items.map((item) => (
          <li
            key={item.address}
            className="space-y-2 rounded-xl bg-raised p-3 text-xs"
          >
            <p className="font-semibold">{t(`kolReview.${item.kind}`)}</p>
            <p className="break-all font-mono">{item.address}</p>
            {fields
              .filter(
                (f) =>
                  item.kind === "new" ||
                  item.kind === "remove" ||
                  item.before?.[f] !== item.after?.[f],
              )
              .map((f) => (
                <div key={f} className="space-y-1 border-t-2 border-dotted border-border pt-2">
                  <p className="font-medium">{t(`admin.kols.${labels[f]}`)}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="min-w-0">
                      <span className="text-muted-foreground">
                        {t("kolReview.before")}
                      </span>
                      <p className="break-all">{value(item.before?.[f])}</p>
                    </div>
                    <div className="min-w-0">
                      <span className="text-muted-foreground">
                        {t("kolReview.after")}
                      </span>
                      <p className="break-all">{value(item.after?.[f])}</p>
                    </div>
                  </div>
                </div>
              ))}
          </li>
        ))}
      </ul>
      {d.hasMore && (
        <p className="text-xs text-muted-foreground">{t("kolReview.limit")}</p>
      )}
    </section>
  );
}
