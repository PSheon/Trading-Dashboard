"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminUser, AdminUsersResponse, PatchAdminUserRequest, UserRole } from "@trading-dashboard/shared";
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState, Panel, Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { truncateAddress } from "@/lib/format";

const PAGE = 20;

export function AdminUsers() {
  const { t, format } = useI18n();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => {
      setQ(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (q) qs.set("q", q);
  if (role) qs.set("role", role);
  const users = useQuery({
    queryKey: ["admin", "users", qs.toString()],
    queryFn: () => api.get<AdminUsersResponse>(`/admin/users?${qs.toString()}`),
    placeholderData: keepPreviousData,
    refetchInterval: false,
  });

  const update = useMutation<AdminUser, ApiError, { id: number; patch: PatchAdminUserRequest }>({
    mutationFn: ({ id, patch }) => api.patch<AdminUser>(`/admin/users/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("admin.users.search")}
            aria-label={t("admin.users.search")}
            className="h-10 w-full rounded-full bg-raised pr-4 pl-10 text-sm outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value as UserRole | "");
            setPage(0);
          }}
          aria-label={t("admin.users.allRoles")}
          className="h-10 rounded-full bg-raised px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="" className="bg-popover">
            {t("admin.users.allRoles")}
          </option>
          {(["user", "admin"] as const).map((r) => (
            <option key={r} value={r} className="bg-popover">
              {t(`admin.users.roles.${r}`)}
            </option>
          ))}
        </select>
        {users.data ? (
          <span className="num ml-auto text-xs text-muted-foreground">{t("admin.users.total", { total })}</span>
        ) : null}
      </div>

      {update.isError ? (
        <p role="alert" className="rounded-xl bg-negative-soft px-4 py-2.5 text-sm text-negative">
          {t("admin.users.failed", { message: update.error.message })}
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        {users.isError ? (
          <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
        ) : !users.data ? (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
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
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={self || busy}
                      onClick={() => update.mutate({ id: u.id, patch: { role: u.role === "admin" ? "user" : "admin" } })}
                    >
                      {u.role === "admin" ? t("admin.users.makeUser") : t("admin.users.makeAdmin")}
                    </Button>
                    <Button
                      variant={u.disabled ? "secondary" : "destructive"}
                      size="xs"
                      disabled={self || busy}
                      onClick={() => update.mutate({ id: u.id, patch: { disabled: !u.disabled } })}
                    >
                      {u.disabled ? t("admin.users.enable") : t("admin.users.disable")}
                    </Button>
                  </div>
                );
                return (
                  <TableRow key={u.id} className={cn(u.disabled && "opacity-60")}>
                    <TableCell>
                      <span className="flex items-center gap-2.5">
                        <AddressAvatar seed={u.walletAddress ?? u.email ?? String(u.id)} size={28} />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5 font-semibold">
                            <span className="max-w-[10rem] truncate">{u.displayName ?? u.email ?? `#${u.id}`}</span>
                            {self ? (
                              <span className="rounded-full bg-primary-soft px-1.5 text-[10px] font-semibold text-primary">
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
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          u.role === "admin" ? "bg-primary-soft text-primary" : "bg-raised text-muted-foreground",
                        )}
                      >
                        {t(`admin.users.roles.${u.role}`)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{t(`locales.${u.locale}`)}</TableCell>
                    <TableCell className="hidden text-right md:table-cell">{u.favorites}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className={u.telegramEnabled ? "text-positive" : "text-subtle-foreground"}>
                        {u.telegramEnabled ? t("common.enabled") : "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={u.disabled ? "text-negative" : "text-muted-foreground"}>
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
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
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
      </Panel>
    </div>
  );
}
