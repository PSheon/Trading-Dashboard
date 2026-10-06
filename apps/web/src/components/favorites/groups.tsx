"use client";

import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/provider";
import { useModalFocus } from "@/lib/use-modal-focus";
import { FAVORITE_GROUP_NAME_MAX, type FavoriteGroup } from "@/lib/contracts";
import { useCreateFavoriteGroup, useDeleteFavoriteGroup, useToggleGroupMember } from "@/lib/favorite-groups";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";

/**
 * CopyDog's watchlist chip row: 全部 (count), each group (colour dot, name,
 * count; its × deletes it after a confirmation — shown on hover, and always
 * where there is no hover, on a phone) and ＋ 新增分組 (an inline name
 * field). Membership is the ＋ on each trader (GroupTags). Groups are not
 * renamed or reordered here: CopyDog has neither (owner's decision,
 * 2026-10-02). Failures are toasts (lib/favorite-groups), as on CopyDog.
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
          delete and new-group buttons, which a tablist may not contain. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("favorites.groups.label")}>
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
              className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-border-strong text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-negative hover:text-primary-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
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
              className="h-11 w-40 rounded-full border-2 border-primary bg-transparent px-4 text-sm font-bold outline-none"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="orbit-press inline-flex h-11 items-center gap-1.5 rounded-full border-2 border-dashed border-input px-[18px] text-sm font-extrabold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
            {t("favorites.groups.new")}
          </button>
        )}
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
        "orbit-press inline-flex h-11 items-center gap-2 rounded-full border-2 px-[18px] text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary bg-primary font-extrabold text-primary-foreground" : "border-input font-bold text-muted-foreground hover:bg-raised hover:text-foreground",
      )}
    >
      {children}
      <span className={cn("num text-xs", active ? "opacity-80" : "text-subtle-foreground")}>{count}</span>
    </button>
  );
}

/** A centred dialog over a dimmed page; Escape and the backdrop close it,
 * and focus stays inside while it is open (lib/use-modal-focus). */
export function Dialog({ title, onClose, children, className }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label={title} className="absolute inset-0 bg-overlay" onClick={onClose} tabIndex={-1} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cn("relative w-full max-w-sm rounded-2xl bg-popover shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] p-6", className)}>
        <h2 className="type-h2 mb-2">{title}</h2>
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
          loading={remove.isPending} disabled={!(remove.isPending) && (remove.isPending)}
          onClick={() => remove.mutate(group.id, { onSuccess: () => { onDeleted(); onClose(); } })}
        >
          {t("favorites.groups.confirmDelete")}
        </Button>
      </div>
    </Dialog>
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
        <span key={g.id} data-slot="group-tag" className="chip-sm" style={{ backgroundColor: `${g.color}22`, color: g.color }}>
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
                    aria-busy={(toggle.isPending && toggle.variables?.id === g.id) || undefined}
                    onClick={() => { if (!toggle.isPending) toggle.mutate({ id: g.id, address, member: !member }); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    {toggle.isPending && toggle.variables?.id === g.id ? <OrbitSpinner className="size-4 text-primary-text" /> : member ? <Check className="size-4 text-primary-text" /> : null}
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
