"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportLeaderListResponse, LeaderList } from "@trading-dashboard/shared";
import { FileUp, ListOrdered } from "lucide-react";
import { useState } from "react";

import { EmptyState, ErrorState, Panel, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import { parseCsv } from "@/lib/csv";

/** A1 list import (CSV/JSON, parsed client-side) and A6 list versions. */
export function AdminLists() {
  const { t, format } = useI18n();
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState<string>();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [parseError, setParseError] = useState<string>();

  const lists = useQuery({
    queryKey: ["admin", "lists"],
    queryFn: () => api.get<LeaderList[]>("/lists"),
    refetchInterval: false,
  });

  const importList = useMutation<ImportLeaderListResponse, ApiError>({
    mutationFn: () =>
      api.post<ImportLeaderListResponse>("/import/lists", {
        source: "copydog",
        fileName: fileName ?? "unknown",
        rows,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "lists"] }),
  });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(undefined);
    setFileName(file.name);
    importList.reset();
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed: unknown = JSON.parse(text);
        setRows((Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]);
      } else {
        setRows(parseCsv(text));
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t("admin.parseFailed"));
      setRows([]);
    }
  }

  const preview = rows.slice(0, 5);
  const columns = preview.length > 0 ? Object.keys(preview[0]) : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Panel className="flex flex-col gap-4 p-5 md:p-6">
        <div>
          <h2 className="text-base font-bold tracking-tight">{t("admin.importTitle")}</h2>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{t("admin.importHint")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="list-file">{t("admin.file")}</Label>
          <Input id="list-file" type="file" accept=".csv,.json" onChange={onFile} className="h-11 py-1.5" />
        </div>
        {parseError ? <p className="text-sm text-negative">{parseError}</p> : null}
        {rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {t("admin.parsed", { count: rows.length, file: fileName ?? "" })}
            </p>
            <div className="overflow-hidden rounded-xl border border-border">
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
          <Button disabled={rows.length === 0 || importList.isPending} onClick={() => importList.mutate()}>
            <FileUp />
            {importList.isPending ? t("admin.importing") : t("admin.importCta")}
          </Button>
          {importList.isError ? (
            <p className="text-sm text-negative">{t("admin.importFailed", { message: importList.error.message })}</p>
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
      </Panel>

      <Panel className="overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-bold tracking-tight">{t("admin.listsTitle")}</h2>
        </div>
        {lists.isError ? (
          <ErrorState message={lists.error.message} onRetry={() => lists.refetch()} />
        ) : !lists.data ? (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : lists.data.length === 0 ? (
          <EmptyState icon={ListOrdered} title={t("admin.listsEmpty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("admin.listCols.id")}</TableHead>
                <TableHead>{t("admin.listCols.file")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("admin.listCols.source")}</TableHead>
                <TableHead className="text-right">{t("admin.listCols.importedAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-semibold text-primary">#{l.id}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs">{l.fileName}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{l.source}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{format.dateTime(l.importedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
