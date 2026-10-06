"use client";

import { useSaveToast } from "@/lib/use-action-toast";
import { BadgeCheck, Pencil, Trash2, UserRound } from "lucide-react";
import { useState } from "react";

import { KolImportPanel } from "./kol-import";
import { TraderAvatar } from "@/components/discover/board-bits";
import { EmptyState, ErrorState } from "@/components/page";
import { Modal } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
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
  const saved = useSaveToast();
  const save = useSaveKol();
  const remove = useRemoveKol();
  const [draft, setDraft] = useState<KolDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  if (!canManage) return <EmptyState title={t("admin.forbiddenTitle")} body={t("admin.forbidden")} />;

  const set = <K extends keyof KolDraft>(key: K, value: KolDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const valid = /^0x[0-9a-fA-F]{40}$/.test(draft.address) && (draft.xHandle === null || /^[A-Za-z0-9_]{1,15}$/.test(draft.xHandle));
  const close = () => { setFormOpen(false); setDraft(EMPTY); setEditing(false); save.reset(); };

  return (
    <section aria-labelledby="kols-title" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="kols-title" className="type-h2 flex items-baseline gap-2">
          {t("admin.kols.registry")}
          <span className="num text-sm font-extrabold text-muted-foreground">{t("admin.kols.count", { count: kols.data?.length ?? 0 })}</span>
        </h2>
        <span className="flex gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>{t("admin.kols.importCsv")}</Button>
          <Button onClick={() => { setDraft(EMPTY); setEditing(false); setFormOpen(true); }}>{t("admin.kols.addTitle")}</Button>
        </span>
      </div>
      {kols.isError ? (
        <ErrorState message={kols.error.message} onRetry={() => kols.refetch()} />
      ) : !kols.data ? (
        <TableSkeleton rows={6} columns={[{ label: t("admin.kols.name"), bar: "w-32" }, { label: t("admin.kols.xHandle") }, { label: t("admin.kols.address"), className: "hidden md:table-cell" }, { label: "#", className: "hidden sm:table-cell" }, { label: t("admin.kols.actions"), right: true }]} />
      ) : kols.data.length === 0 ? (
        <EmptyState icon={UserRound} title={t("discover.kolEmpty")} body={t("admin.kols.emptyHint")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("admin.kols.name")}</TableHead>
              <TableHead>{t("admin.kols.xHandle")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("admin.kols.address")}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t("admin.kols.order")}</TableHead>
              <TableHead className="text-right">{t("admin.kols.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {kols.data.map((kol) => (
              <TableRow key={kol.address}>
                <TableCell>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <TraderAvatar trader={{ address: kol.address, avatarUrl: kol.cachedAvatarUrl ?? null }} size={28} />
                    <span className="flex min-w-0 items-center gap-1 truncate">
                      {kol.displayName ?? "—"}
                      {kol.verified ? <BadgeCheck className="size-3.5 shrink-0 fill-sky-500 text-background" aria-label={t("discover.verified")} /> : null}
                    </span>
                  </span>
                </TableCell>
                <TableCell>{kol.xHandle ? `@${kol.xHandle}` : "—"}</TableCell>
                <TableCell className="hidden md:table-cell" title={kol.address}>{truncateAddress(kol.address)}</TableCell>
                <TableCell className="hidden text-right text-muted-foreground sm:table-cell">{kol.sortOrder}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t("admin.kols.edit")} ${kol.displayName ?? kol.address}`}
                    onClick={() => {
                      setEditing(true);
                      setDraft({ address: kol.address, displayName: kol.displayName, avatarUrl: kol.avatarUrl, xHandle: kol.xHandle, verified: kol.verified, sortOrder: kol.sortOrder });
                      setFormOpen(true);
                    }}
                  >
                    <Pencil />
                    <span className="hidden sm:inline">{t("admin.kols.edit")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t("admin.kols.remove")} ${kol.displayName ?? kol.address}`}
                    loading={remove.isPending && remove.variables === kol.address} disabled={!(remove.isPending && remove.variables === kol.address) && (remove.isPending)}
                    onClick={() => {
                      if (globalThis.confirm(t("admin.kols.confirmRemove", { name: kol.displayName ?? kol.address }))) remove.mutate(kol.address, saved());
                    }}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Modal open={formOpen} onOpenChange={(next) => { if (!next) close(); }} title={editing ? t("admin.kols.editTitle") : t("admin.kols.addTitle")}>
        <p className="type-caption mb-4">{t("admin.kols.hint")}</p>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            save.mutate({ draft: { ...draft, address: draft.address.toLowerCase() }, existing: editing }, saved({ onSuccess: close }));
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
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={draft.verified} onChange={(e) => set("verified", e.target.checked)} className="size-4 accent-primary" />
            {t("admin.kols.verified")}
          </label>
          {save.error ? <p className="text-sm text-negative">{save.error.message}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>{t("admin.kols.cancel")}</Button>
            <Button type="submit" loading={save.isPending} disabled={!(save.isPending) && (!valid || save.isPending)}>{t("admin.kols.save")}</Button>
          </div>
        </form>
      </Modal>
      <Drawer open={importOpen} onOpenChange={setImportOpen} title={t("admin.kols.importCsv")}>
        <KolImportPanel registryRevision={JSON.stringify(kols.data ?? [])} registryReady={kols.isSuccess && !kols.isFetching} />
      </Drawer>
    </section>
  );
}
