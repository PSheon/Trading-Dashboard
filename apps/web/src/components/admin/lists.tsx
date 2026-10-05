"use client";
import { importLeaderListRequestSchema } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";
import { usePermission } from "@/lib/auth";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ImportLeaderListRequest,
  ImportPreview,
  ImportLeaderListResponse,
  LeaderList,
} from "@/lib/contracts";
import { FileUp, ListOrdered } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState, ErrorState, Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { TableSkeleton } from "@/components/ui/table-skeleton";

/** A1 list import (CSV/JSON, parsed client-side) and A6 list versions. */
export function AdminLists() {
  const canImport = usePermission("leaders.import");
  const { t, format } = useI18n();
  const queryClient = useQueryClient();
  const [source, setSource] = useState("copydog");
  const fileRead = useRef(0);
  const [fileName, setFileName] = useState<string>();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [parseError, setParseError] = useState<string>();

  const lists = useQuery({
    queryKey: queryKeys.admin.lists,
    queryFn: ({ signal }) => api.get<LeaderList[]>("/lists", signal),
    refetchInterval: false,
  });

  const payload: ImportLeaderListRequest = {
    source,
    fileName: fileName ?? "unknown",
    rows,
  };
  const review = useMutation<ImportPreview, ApiError, ImportLeaderListRequest>({
    mutationFn: (body) => api.post("/import/lists/preview", body),
  });
  const reviewed =
    review.isSuccess &&
    review.variables?.rows === rows &&
    review.variables.source === source &&
    review.variables.fileName === fileName;
  const importList = useMutation<
    ImportLeaderListResponse,
    ApiError,
    ImportLeaderListRequest
  >({
    mutationFn: (body) =>
      api.post<ImportLeaderListResponse>("/import/lists", body),
    onSuccess: () => {
      review.reset();
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.lists });
      queryClient.invalidateQueries({ queryKey: ["admin", "sources"] });
    },
  });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const readId = ++fileRead.current;
    setRows([]);
    review.reset();
    setParseError(undefined);
    setFileName(file.name);
    importList.reset();
    try {
      if (file.size > 100 * 1024) throw new Error(t("importOps.tooLarge"));
      const text = await file.text();
      if (readId !== fileRead.current) return;
      const raw:unknown=file.name.toLowerCase().endsWith(".json")?JSON.parse(text):parseCsv(text);
      const validated=importLeaderListRequestSchema.shape.rows.safeParse(Array.isArray(raw)?raw:[raw]);
      if(!validated.success)throw new Error(t("admin.parseFailed"));
      setRows(validated.data);
    } catch (err) {
      if (readId !== fileRead.current) return;
      setParseError(
        err instanceof Error ? err.message : t("admin.parseFailed"),
      );
      setRows([]);
    }
  }

  const preview = rows.slice(0, 5);
  const columns = preview.length > 0 ? Object.keys(preview[0]) : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Panel className="flex min-w-0 flex-col gap-4 p-5 md:p-6">
        <div>
          <h2 className="type-h2">
            {t("admin.importTitle")}
          </h2>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
            {t("admin.importHint")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="import-source">{t("importOps.source")}</Label>
          <Input
            id="import-source"
            value={source}
            maxLength={64}
            disabled={importList.isPending}
            onChange={(e) => {
              setSource(e.target.value);
              review.reset();
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="list-file">{t("admin.file")}</Label>
          <Input
            id="list-file"
            type="file"
            disabled={importList.isPending}
            accept=".csv,.json"
            onChange={onFile}
            className="h-11 py-1.5"
          />
        </div>
        {parseError ? (
          <p className="text-sm text-negative">{parseError}</p>
        ) : null}
        {rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {t("admin.parsed", { count: rows.length, file: fileName ?? "" })}
            </p>
            <div className="overflow-hidden rounded-xl">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {columns.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row, i) => (
                    <TableRow key={i}>
                      {columns.map((c) => (
                        <TableCell key={c} className="max-w-48 truncate">
                          {String(row[c] ?? "")}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            disabled={
              !canImport ||
              !rows.length ||
              !source.trim() ||
              review.isPending ||
              importList.isPending
            }
            onClick={() => review.mutate(payload)}
          >
            {review.isPending
              ? t("importOps.checking")
              : t("importOps.preview")}
          </Button>
          <Button
            disabled={
              !canImport ||
              !reviewed ||
              !review.data?.canImport ||
              importList.isPending ||
              review.isPending
            }
            onClick={() => importList.mutate(payload)}
          >
            <FileUp />
            {importList.isPending
              ? t("admin.importing")
              : t("importOps.confirm")}
          </Button>
          {review.isError && (
            <p role="alert" className="text-sm text-negative">
              {review.error.message}
            </p>
          )}
          {importList.isError ? (
            <p className="text-sm text-negative">
              {t("admin.importFailed", { message: importList.error.message })}
            </p>
          ) : null}
          {importList.isSuccess ? (
            <p className="text-sm text-positive">
              {t("admin.imported", {
                id: importList.data.listId,
                count: importList.data.itemCount,
                fresh: importList.data.newAddresses.length,
              })}
            </p>
          ) : null}
        </div>
        {reviewed && <ImportImpact data={review.data!} />}
      </Panel>

      <Panel className="overflow-hidden">
        <div className="border-b-2 border-dotted border-border px-5 py-4">
          <h2 className="type-h2">
            {t("admin.listsTitle")}
          </h2>
        </div>
        {lists.isError ? (
          <ErrorState
            message={lists.error.message}
            onRetry={() => lists.refetch()}
          />
        ) : !lists.data ? (
          <TableSkeleton
            rows={3}
            columns={[
              { label: t("admin.listCols.id"), bar: "w-8" },
              { label: t("admin.listCols.file"), bar: "w-40" },
              { label: t("admin.listCols.source"), className: "hidden sm:table-cell" },
              { label: t("admin.listCols.importedAt"), right: true },
            ]}
          />
        ) : lists.data.length === 0 ? (
          <EmptyState icon={ListOrdered} title={t("admin.listsEmpty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("admin.listCols.id")}</TableHead>
                <TableHead>{t("admin.listCols.file")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("admin.listCols.source")}
                </TableHead>
                <TableHead className="text-right">
                  {t("admin.listCols.importedAt")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-semibold text-primary-text">
                    #{l.id}
                  </TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs">
                    {l.fileName}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {l.source}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {format.dateTime(l.importedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

function ImportImpact({ data: d }: { data: ImportPreview }) {
  const { t, format } = useI18n();
  const counts = [
    ["total", d.totalRows],
    ["unique", d.uniqueAddresses],
    ["duplicates", d.duplicateRows],
    ["new", d.newAddresses],
    ["promote", d.promotedAddresses],
    ["preserve", d.preservedAddresses],
    ["jobs", d.estimatedNewJobs],
  ] as const;
  return (
    <section
      aria-label={t("importOps.impact")}
      className="space-y-3 border-t-2 border-dotted border-border pt-4"
    >
      <h3 className="type-h2">{t("importOps.impact")}</h3>
      <p className="text-xs text-muted-foreground">{t("importOps.hint")}</p>
      <p className="text-xs text-muted-foreground">
        {t("importOps.sampled")}: {format.dateTime(d.sampledAt)}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {counts.map(([key, value]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(`importOps.${key}`)}</dt>
            <dd className="font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {!d.canImport && (
        <p role="alert" className="text-sm text-negative">
          {t("importOps.blocked")}
        </p>
      )}
      <ul className="space-y-1 text-xs text-negative">
        {d.errors.slice(0, 50).map((e) => (
          <li key={e.index}>
            {t("importOps.invalid", { row: e.index + 1, reason: e.reason })}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t("importOps.rules")}</p>
      <ul className="max-h-80 space-y-2 overflow-y-auto text-xs">
        {d.items.slice(0, 50).map((item) => (
          <li key={item.address} className="space-y-1 rounded-lg bg-raised p-3">
            <p className="break-all font-mono">{item.address}</p>
            <p>
              {t(`importOps.${item.action}`)} · {t("adminTrader.rank")}:{" "}
              {item.rank} · {t("importOps.tier")}: {item.tierAfter} ·{" "}
              {t(
                item.activeAfter
                  ? "adminTrader.active"
                  : "adminTrader.inactive",
              )}
            </p>
          </li>
        ))}
      </ul>
      {(d.items.length > 50 || d.errors.length > 50) && (
        <p className="text-xs text-muted-foreground">{t("importOps.limit")}</p>
      )}
    </section>
  );
}
