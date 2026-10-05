"use client";

import { BadgeCheck, Pencil, Trash2, UserRound } from "lucide-react";
import { useState } from "react";

import { KolImportPanel } from "./kol-import";
import { TraderAvatar } from "@/components/discover/board-bits";
import { EmptyState, ErrorState, Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useKols, useRemoveKol, useSaveKol, type KolDraft } from "@/lib/admin-kols";
import { usePermission } from "@/lib/auth";
import { truncateAddress } from "@/lib/format";
import { TableSkeleton } from "@/components/ui/table-skeleton";

const EMPTY: KolDraft = { address: "", displayName: null, avatarUrl: null, xHandle: null, verified: false, sortOrder: 0 };

/** The KOL registry (Stage 3 §1.7): the explore KOL board and home 精選.
 * List, add / edit (upsert by address), remove, CSV import. */
export function AdminKols() {
  const { t } = useI18n();
  const canManage = usePermission("kols.manage");
  const kols = useKols();
  const save = useSaveKol();
  const remove = useRemoveKol();
  const [draft, setDraft] = useState<KolDraft>(EMPTY);
  const [editing, setEditing] = useState(false);

  if (!canManage) return <EmptyState title={t("admin.forbiddenTitle")} body={t("admin.forbidden")} />;

  const set = <K extends keyof KolDraft>(key: K, value: KolDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const valid = /^0x[0-9a-fA-F]{40}$/.test(draft.address) && (draft.xHandle === null || /^[A-Za-z0-9_]{1,15}$/.test(draft.xHandle));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel className="flex flex-col gap-4 p-5 md:p-6">
          <div>
            <h2 className="text-base font-bold">{editing ? t("admin.kols.editTitle") : t("admin.kols.addTitle")}</h2>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{t("admin.kols.hint")}</p>
          </div>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              save.mutate({ draft: { ...draft, address: draft.address.toLowerCase() }, existing: editing }, {
                onSuccess: () => {
                  setDraft(EMPTY);
                  setEditing(false);
                },
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="kol-address">{t("admin.kols.address")}</Label>
              <Input id="kol-address" value={draft.address} disabled={editing} onChange={(e) => set("address", e.target.value.trim())} placeholder="0x…" className="font-mono" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kol-name">{t("admin.kols.name")}</Label>
              <Input id="kol-name" value={draft.displayName ?? ""} maxLength={64} onChange={(e) => set("displayName", e.target.value || null)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="kol-x">{t("admin.kols.xHandle")}</Label>
                <Input id="kol-x" value={draft.xHandle ?? ""} onChange={(e) => set("xHandle", e.target.value.replace(/^@/, "") || null)} placeholder="handle" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kol-order">{t("admin.kols.order")}</Label>
                <Input id="kol-order" type="number" min={0} value={draft.sortOrder} onChange={(e) => set("sortOrder", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kol-avatar">{t("admin.kols.avatar")}</Label>
              <Input id="kol-avatar" value={draft.avatarUrl ?? ""} onChange={(e) => set("avatarUrl", e.target.value.trim() || null)} placeholder="https://…" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.verified} onChange={(e) => set("verified", e.target.checked)} className="size-4 accent-primary" />
              {t("admin.kols.verified")}
            </label>
            {save.error ? <p className="text-sm text-negative">{save.error.message}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={!valid || save.isPending}>{t("admin.kols.save")}</Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={() => { setDraft(EMPTY); setEditing(false); }}>
                  {t("admin.kols.cancel")}
                </Button>
              ) : null}
            </div>
          </form>
        </Panel>

        <KolImportPanel registryRevision={JSON.stringify(kols.data??[])} registryReady={kols.isSuccess&&!kols.isFetching}/>
      </div>

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between border-b-2 border-dotted border-border px-5 py-4">
          <h2 className="text-base font-bold">{t("admin.kols.listTitle", { count: String(kols.data?.length ?? 0) })}</h2>
        </div>
        {kols.isError ? (
          <ErrorState message={kols.error.message} onRetry={() => kols.refetch()} />
        ) : !kols.data ? (
          <TableSkeleton
            dense
            rows={6}
            columns={[
              { label: "#", bar: "w-5", className: "w-12" },
              { label: t("admin.kols.name"), bar: "w-32" },
              { label: t("admin.kols.xHandle") },
              { label: t("admin.kols.actions"), right: true },
            ]}
          />
        ) : kols.data.length === 0 ? (
          <EmptyState icon={UserRound} title={t("discover.kolEmpty")} body={t("admin.kols.emptyHint")} />
        ) : (
          <div className="max-h-[720px] overflow-y-auto">
            <Table dense>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>{t("admin.kols.name")}</TableHead>
                  <TableHead>{t("admin.kols.xHandle")}</TableHead>
                  <TableHead className="text-right">{t("admin.kols.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kols.data.map((kol) => (
                  <TableRow key={kol.address}>
                    <TableCell className="num text-subtle-foreground">{kol.sortOrder}</TableCell>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <TraderAvatar trader={{ address: kol.address, avatarUrl: kol.cachedAvatarUrl ?? null }} size={24} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 font-semibold">
                            {kol.displayName ?? "—"}
                            {kol.verified ? <BadgeCheck className="size-3.5 fill-sky-500 text-background" aria-label={t("discover.verified")} /> : null}
                          </span>
                          <span className="block font-mono text-[11px] text-subtle-foreground" title={kol.address}>{truncateAddress(kol.address)}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{kol.xHandle ? `@${kol.xHandle}` : "—"}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("admin.kols.edit")} ${kol.displayName ?? kol.address}`}
                        onClick={() => {
                          setEditing(true);
                          setDraft({ address: kol.address, displayName: kol.displayName, avatarUrl: kol.avatarUrl, xHandle: kol.xHandle, verified: kol.verified, sortOrder: kol.sortOrder });
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("admin.kols.remove")} ${kol.displayName ?? kol.address}`}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (globalThis.confirm(t("admin.kols.confirmRemove", { name: kol.displayName ?? kol.address }))) remove.mutate(kol.address);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}
