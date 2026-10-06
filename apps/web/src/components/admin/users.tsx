"use client";

import { useSaveToast } from "@/lib/use-action-toast";
import { LOCALE_NAMES, type Locale } from "@/i18n/config";
import { userRoleEnum, type AdminUser, type UserRole } from "@/lib/contracts";
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState } from "@/components/page";
import { Label } from "@/components/ui/label";
import { AdminSubTabs } from "./admin-shell";
import { Notice } from "./ui";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { useAdminUsers, useUpdateAdminUser } from "@/lib/admin-users";
import { useMe, usePermission } from "@/lib/auth";
import { truncateAddress } from "@/lib/format";
import { UnresolvedWithdrawals } from "./unresolved-withdrawals";
import { TableSkeleton } from "@/components/ui/table-skeleton";

const PAGE = 20;

/** A role change or a disable / enable waiting for its confirmation. */
type Pending = { user: AdminUser; role: UserRole } | { user: AdminUser; disabled: boolean };
const ROLE_TONE: Record<UserRole, string> = {
  admin: "bg-tag-alert text-tag-alert-foreground",
  operator: "bg-tag-warning text-tag-warning-foreground",
  user: "text-muted-foreground",
};

export const USERS_SUB_TABS = { "/admin/users": "admin.sub.users", "/admin/users/audit": "admin.sub.audit" } as const;

export function AdminUsers() {
  const { t, format } = useI18n();
  const { data: me } = useMe();
  const canManage = usePermission("users.manage");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [page, setPage] = useState(0);
  // Nothing is sent on the first click (review finding 63): a role change and a disable are confirmed.
  const [pending, setPending] = useState<Pending | null>(null);
  const [managing, setManaging] = useState<AdminUser | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      setQ(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const users = useAdminUsers({ q, role, limit: PAGE, offset: page * PAGE });
  const saved = useSaveToast();
  const update = useUpdateAdminUser();

  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex flex-col gap-5">
      <AdminSubTabs tab="users" labels={USERS_SUB_TABS} />
      <UnresolvedWithdrawals />
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative w-full sm:w-[360px]">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("admin.users.search")}
            aria-label={t("admin.users.search")}
            className="h-12 w-full rounded-full border-2 border-transparent bg-raised pr-4 pl-11 text-[15px] font-bold outline-none placeholder:text-subtle-foreground focus-visible:border-primary"
          />
        </div>
        <Select
          size="sm"
          value={role}
          onValueChange={(value) => {
            setRole(value as UserRole | "");
            setPage(0);
          }}
          label={t("admin.users.roleFilter")}
          prefix={t("admin.users.cols.role")}
          options={[{ value: "", label: t("admin.users.allShort") }, ...userRoleEnum.map((r) => ({ value: r, label: t(`admin.users.roles.${r}`) }))]}
        />
        {users.data ? (
          <span className="num type-caption ml-auto">{t("admin.users.total", { total })}</span>
        ) : null}
      </div>

      {update.isError ? (
        <Notice tone="negative">{t("admin.users.failed", { message: update.error.message })}</Notice>
      ) : null}

      <div className="min-w-0">
        {users.isError ? (
          <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
        ) : !users.data ? (
          <TableSkeleton
            rows={8}
            columns={[
              { label: t("admin.users.cols.user"), bar: "w-32" },
              { label: t("admin.users.cols.role") },
              { label: t("admin.users.cols.locale"), className: "hidden md:table-cell" },
              { label: t("admin.users.cols.favorites"), right: true, className: "hidden md:table-cell" },
              { label: t("admin.users.cols.telegram"), className: "hidden lg:table-cell" },
              { label: t("admin.users.cols.status") },
              { label: t("admin.users.cols.created"), className: "hidden xl:table-cell" },
              { label: t("admin.users.cols.lastLogin"), className: "hidden lg:table-cell" },
              { label: t("admin.users.cols.actions"), right: true },
            ]}
          />
        ) : users.data.items.length === 0 ? (
          <EmptyState icon={Users} title={t("admin.users.empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("admin.users.cols.user")}</TableHead>
                <TableHead>{t("admin.users.cols.role")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin.users.cols.locale")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("admin.users.cols.favorites")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin.users.cols.telegram")}</TableHead>
                <TableHead>{t("admin.users.cols.status")}</TableHead>
                <TableHead className="hidden xl:table-cell">{t("admin.users.cols.created")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin.users.cols.lastLogin")}</TableHead>
                <TableHead className="text-right">{t("admin.users.cols.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.items.map((u) => {
                const self = u.id === me?.id;
                const busy = update.isPending && update.variables?.id === u.id;
                const actions = (
                  <Button variant="inverse" size="sm" disabled={busy} onClick={() => setManaging(u)} aria-label={t("admin.users.manageUser", { name: nameOf(u) })}>
                    {t("admin.users.manage")}
                  </Button>
                );
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <span className="flex items-center gap-2.5">
                        <AddressAvatar seed={u.walletAddress ?? u.email ?? String(u.id)} size={28} />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5 font-semibold">
                            <span className="max-w-[10rem] truncate">{u.displayName ?? u.email ?? `#${u.id}`}</span>
                            {self ? (
                              <span className="rounded-full bg-tag-alert px-1.5 text-[10px] font-semibold text-tag-alert-foreground">
                                {t("common.you")}
                              </span>
                            ) : null}
                          </span>
                          <span className="max-w-[14rem] truncate font-mono text-[11px] text-subtle-foreground">
                            {u.email ?? (u.walletAddress ? truncateAddress(u.walletAddress) : "")}
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={cn("chip-sm", ROLE_TONE[u.role])}>
                        {t(`admin.users.roles.${u.role}`)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{LOCALE_NAMES[u.locale as Locale] ?? u.locale}</TableCell>
                    <TableCell className="hidden text-right md:table-cell">{u.favorites}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {u.telegramEnabled ? <span className="chip-sm bg-tag-profit text-tag-profit-foreground">{t("admin.users.linked")}</span> : <span className="text-muted-foreground">{t("admin.users.notLinked")}</span>}
                    </TableCell>
                    <TableCell>
                      <span className={cn("chip-sm", u.disabled ? "bg-tag-loss text-tag-loss-foreground" : "bg-tag-profit text-tag-profit-foreground")}>
                        {u.disabled ? t("admin.users.disabled") : t("admin.users.active")}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">{format.date(u.createdAt)}</TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{format.relative(u.lastLoginAt)}</TableCell>
                    <TableCell className="text-right">
                      {self ? (
                        <Tooltip content={t("admin.users.selfHint")}>
                          <span tabIndex={0} className="inline-block">
                            {actions}
                          </span>
                        </Tooltip>
                      ) : (
                        actions
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {users.data && total > PAGE ? (
          <div className="flex items-center justify-between pt-3">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
              {t("common.prev")}
            </Button>
            <span className="num text-xs text-muted-foreground">{t("common.page", { page: page + 1, pages })}</span>
            <Button variant="secondary" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              {t("common.next")}
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </div>
      <ManageDialog user={managing} self={managing?.id === me?.id} canManage={canManage} onClose={() => setManaging(null)}
        onPick={(change) => { setManaging(null); setPending(change); }} />
      <ConfirmChange
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={(change) => {
          update.mutate({ id: change.user.id, patch: "role" in change ? { role: change.role } : { disabled: change.disabled } }, saved());
          setPending(null);
        }}
      />
    </div>
  );
}

const nameOf = (u: AdminUser) => u.displayName ?? u.email ?? `#${u.id}`;

/** 管理: the user's role pack and access, each change confirmed next. */
function ManageDialog({ user, self, canManage, onClose, onPick }: { user: AdminUser | null; self: boolean; canManage: boolean; onClose: () => void; onPick: (change: Pending) => void }) {
  const { t } = useI18n();
  return (
    <Modal open={user !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={user ? nameOf(user) : ""}>
      {user ? (
        <div className="flex flex-col gap-4">
          {self ? <p className="type-caption">{t("admin.users.selfHint")}</p> : !canManage ? <p className="type-caption">{t("admin.users.readOnly")}</p> : null}
          <div className="grid gap-2">
            <Label htmlFor="manage-role">{t("admin.users.cols.role")}</Label>
            <Select id="manage-role" label={t("adminOps.users.role", { name: nameOf(user) })} value={user.role} disabled={!canManage || self}
              onValueChange={(value) => { if (value !== user.role) onPick({ user, role: value as UserRole }); }}
              options={userRoleEnum.map((r) => ({ value: r, label: t(`admin.users.roles.${r}`) }))} />
            <p className="type-caption">{t(`adminOps.users.grants.${user.role}`)}</p>
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t-2 border-dotted border-border pt-4">
            <Button variant={user.disabled ? "secondary" : "destructive"} disabled={!canManage || self} onClick={() => onPick({ user, disabled: !user.disabled })}>
              {user.disabled ? t("admin.users.enable") : t("admin.users.disable")}
            </Button>
            <Button variant="secondary" onClick={onClose}>{t("adminOps.users.cancel")}</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ConfirmChange({ pending, onCancel, onConfirm }: { pending: Pending | null; onCancel: () => void; onConfirm: (change: Pending) => void }) {
  const { t } = useI18n();
  let title = "";
  let body: React.ReactNode = null;
  if (pending && "role" in pending) {
    title = t("adminOps.users.roleTitle");
    body = (
      <>
        <p>{t("adminOps.users.roleBody", { name: nameOf(pending.user), from: t(`admin.users.roles.${pending.user.role}`), to: t(`admin.users.roles.${pending.role}`) })}</p>
        <p className="mt-3 rounded-[22px] bg-inset p-3.5 text-xs font-bold">{t(`adminOps.users.grants.${pending.role}`)}</p>
      </>
    );
  } else if (pending) {
    title = t(pending.disabled ? "adminOps.users.disableTitle" : "adminOps.users.enableTitle");
    body = <p>{t(pending.disabled ? "adminOps.users.disableBody" : "adminOps.users.enableBody", { name: nameOf(pending.user) })}</p>;
  }
  return (
    <Modal open={pending !== null} onOpenChange={(open) => { if (!open) onCancel(); }} title={title}>
      <div className="text-sm leading-relaxed text-muted-foreground">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>{t("adminOps.users.cancel")}</Button>
        <Button type="button" onClick={() => pending && onConfirm(pending)}>{t("adminOps.users.confirm")}</Button>
      </div>
    </Modal>
  );
}
