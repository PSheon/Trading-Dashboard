"use client";

import { ArrowDown, ArrowUp, Check, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/provider";
import { FAVORITE_GROUP_NAME_MAX, type FavoriteGroup } from "@/lib/contracts";
import { useCreateFavoriteGroup, useDeleteFavoriteGroup, usePatchFavoriteGroup, useToggleGroupMember } from "@/lib/favorite-groups";

/**
 * CopyDog's watchlist chip row: 全部 (count), each group (colour dot, name,
 * count; a hover × deletes it after a confirmation), ＋ 新增分組 (an inline
 * name field) and 管理群組 (rename, reorder, delete). Failures are toasts
 * (lib/favorite-groups), as on CopyDog.
 */
export function GroupChips({ groups, counts, total, active, onSelect }: {
  groups: FavoriteGroup[];
  counts: Map<number, number>;
  total: number;
  active: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { t } = useI18n();
  const create = useCreateFavoriteGroup();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<FavoriteGroup | null>(null);
  const [managing, setManaging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return setAdding(false);
    create.mutate({ name: trimmed }, {
      onSuccess: (group) => {
        setName("");
        setAdding(false);
        onSelect(group.id);
      },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Filter chips are toggle buttons, not tabs: the row also holds the
          delete, new-group and manage buttons, which a tablist may not contain. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("favorites.groups.manage")}>
        <Chip active={active === null} onClick={() => onSelect(null)} count={total}>
          {t("favorites.groups.all")}
        </Chip>
        {groups.map((g) => (
          <span key={g.id} className="group relative inline-flex">
            <Chip active={active === g.id} onClick={() => onSelect(active === g.id ? null : g.id)} count={counts.get(g.id) ?? 0}>
              <span className="size-2 rounded-full" style={{ backgroundColor: active === g.id ? "currentColor" : g.color }} aria-hidden />
              {g.name}
            </Chip>
            <button
              type="button"
              onClick={() => setConfirm(g)}
              aria-label={`${t("favorites.groups.delete")} ${g.name}`}
              title={t("favorites.groups.delete")}
              className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-border-strong text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 hover:bg-negative hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-2.5" strokeWidth={3} />
            </button>
          </span>
        ))}
        {adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              ref={input}
              value={name}
              maxLength={FAVORITE_GROUP_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                create.reset();
              }}
              onBlur={() => !name.trim() && setAdding(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setAdding(false);
                  setName("");
                }
              }}
              placeholder={t("favorites.groups.name")}
              aria-label={t("favorites.groups.name")}
              className="h-9 w-36 rounded-full border border-primary bg-transparent px-3.5 text-sm outline-none"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3.5 text-sm font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
            {t("favorites.groups.new")}
          </button>
        )}
        {groups.length > 0 ? (
          <button
            type="button"
            onClick={() => setManaging(true)}
            className="inline-flex h-9 items-center rounded-full px-3 text-sm font-semibold text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("favorites.groups.manage")}
          </button>
        ) : null}
      </div>
      {confirm ? (
        <DeleteGroupDialog
          group={confirm}
          onClose={() => setConfirm(null)}
          onDeleted={() => {
            if (active === confirm.id) onSelect(null);
          }}
        />
      ) : null}
      {managing ? <ManageGroupsDialog groups={groups} onClose={() => setManaging(false)} /> : null}
    </div>
  );
}

function Chip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary text-primary-foreground" : "bg-raised text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      <span className={cn("num text-xs", active ? "opacity-80" : "text-subtle-foreground")}>{count}</span>
    </button>
  );
}

/** A centred dialog over a dimmed page; Escape and the backdrop close it. */
export function Dialog({ title, onClose, children, className }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label={title} className="absolute inset-0 bg-black/60" onClick={onClose} tabIndex={-1} />
      <div role="dialog" aria-modal="true" aria-label={title} className={cn("relative w-full max-w-sm rounded-2xl border border-border-strong bg-popover p-6 shadow-2xl", className)}>
        <h2 className="mb-2 text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DeleteGroupDialog({ group, onClose, onDeleted }: { group: FavoriteGroup; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const remove = useDeleteFavoriteGroup();
  return (
    <Dialog title={t("favorites.groups.deleteTitle")} onClose={onClose}>
      <p className="mb-6 text-sm text-muted-foreground">{t("favorites.groups.deleteMessage", { name: group.name })}</p>
      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>{t("favorites.groups.cancel")}</Button>
        <Button
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => remove.mutate(group.id, { onSuccess: () => { onDeleted(); onClose(); } })}
        >
          {t("favorites.groups.confirmDelete")}
        </Button>
      </div>
    </Dialog>
  );
}

/** 管理群組: rename, move up / down, delete. */
function ManageGroupsDialog({ groups, onClose }: { groups: FavoriteGroup[]; onClose: () => void }) {
  const { t } = useI18n();
  const patch = usePatchFavoriteGroup();
  const [confirm, setConfirm] = useState<FavoriteGroup | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  function move(index: number, by: -1 | 1) {
    const order = [...groups];
    const [g] = order.splice(index, 1);
    order.splice(index + by, 0, g);
    order.forEach((group, i) => {
      if (group.sortOrder !== i) patch.mutate({ id: group.id, patch: { sortOrder: i } });
    });
  }

  if (confirm) return <DeleteGroupDialog group={confirm} onClose={() => setConfirm(null)} onDeleted={() => undefined} />;
  return (
    <Dialog title={t("favorites.groups.manage")} onClose={onClose} className="max-w-md">
      <p className="mb-4 text-xs text-subtle-foreground">{t("favorites.groups.manageHint")}</p>
      <ul className="flex flex-col gap-1.5">
        {groups.map((g, i) => (
          <li key={g.id} className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
            {editing?.id === g.id ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = editing.name.trim();
                  if (!name || name === g.name) return setEditing(null);
                  patch.mutate({ id: g.id, patch: { name } }, { onSuccess: () => setEditing(null) });
                }}
              >
                <Input
                  autoFocus
                  value={editing.name}
                  maxLength={FAVORITE_GROUP_NAME_MAX}
                  onChange={(e) => {
                    setEditing({ id: g.id, name: e.target.value });
                    patch.reset();
                  }}
                  aria-label={t("favorites.groups.rename")}
                  className="h-8"
                />
                <button type="submit" aria-label={t("favorites.groups.done")} className="rounded-full p-1.5 text-positive outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
                  <Check className="size-4" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setEditing({ id: g.id, name: g.name })}
                title={t("favorites.groups.rename")}
                className="min-w-0 flex-1 truncate rounded text-left text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {g.name}
              </button>
            )}
            <span className="num text-xs text-subtle-foreground">{g.addresses.length}</span>
            <IconButton label={t("favorites.groups.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label={t("favorites.groups.moveDown")} disabled={i === groups.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton label={t("favorites.groups.delete")} onClick={() => setConfirm(g)} danger>
              <Trash2 className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("favorites.groups.done")}</Button>
      </div>
    </Dialog>
  );
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30",
        danger ? "hover:text-negative" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** A trader's group tags and the ＋ that opens a checklist of groups. */
export function GroupTags({ address, groups, className }: { address: string; groups: FavoriteGroup[]; className?: string }) {
  const { t } = useI18n();
  const toggle = useToggleGroupMember();
  const mine = groups.filter((g) => g.addresses.includes(address));
  if (groups.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {mine.map((g) => (
        <span key={g.id} data-slot="group-tag" className="rounded-md px-1.5 py-0.5 text-[0.6875rem] font-semibold" style={{ backgroundColor: `${g.color}22`, color: g.color }}>
          {g.name}
        </span>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("favorites.groups.addTo")}
            title={t("favorites.groups.addTo")}
            className="inline-flex size-5 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-raised-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3" strokeWidth={2.5} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1.5" onClick={(e) => e.stopPropagation()}>
          <ul className="flex flex-col" role="listbox" aria-label={t("favorites.groups.addTo")} aria-multiselectable="true">
            {groups.map((g) => {
              const member = g.addresses.includes(address);
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={member}
                    onClick={() => toggle.mutate({ id: g.id, address, member: !member })}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    {member ? <Check className="size-4 text-primary" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </span>
  );
}
