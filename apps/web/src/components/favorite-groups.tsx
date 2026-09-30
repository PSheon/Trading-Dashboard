"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Favorite, FavoriteGroup } from "@/lib/contracts";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Skeleton } from "@/components/page";
import { TraderName } from "@/components/traders/trader-name";

export function useFavoriteGroups() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.favoriteGroups,
    queryFn: ({ signal }) =>
      api.get<FavoriteGroup[]>("/me/favorite-groups", signal),
    enabled: status === "signedIn",
    refetchInterval: 60_000,
  });
}
export function FavoriteGroupsPanel({
  groups,
  favorites,
  selected,
  onSelect,
  loading,
  error,
  onRetry,
}: {
  groups: FavoriteGroup[];
  favorites: Favorite[];
  selected: number | null;
  onSelect: (id: number | null) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const group = groups.find((g) => g.id === selected);
  const mutation = useMutation<
    unknown,
    ApiError,
    {
      kind: "create" | "rename" | "delete" | "add" | "remove";
      id?: number;
      address?: string;
      name?: string;
    }
  >({
    mutationFn: ({ kind, id, address, name }) => {
      if (kind === "create") return api.post("/me/favorite-groups", { name });
      if (kind === "rename")
        return api.patch(`/me/favorite-groups/${id}`, { name });
      if (kind === "delete") return api.delete(`/me/favorite-groups/${id}`);
      if (kind === "add")
        return api.put(`/me/favorite-groups/${id}/members/${address}`);
      return api.delete(`/me/favorite-groups/${id}/members/${address}`);
    },
    onSuccess: (_data, variables) => {
      if (variables.kind === "create" || variables.kind === "rename")
        setName("");
      if (variables.kind === "delete") {
        onSelect(null);
        setConfirmDelete(null);
      }
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: queryKeys.favoriteGroups }),
  });
  if (loading) return <Skeleton className="h-28" />;
  return (
    <Panel className="space-y-3 p-4">
      <h2 className="text-sm font-semibold">{t("groups.title")}</h2>
      <p className="text-xs text-muted-foreground">{t("groups.hint")}</p>
      {error ? (
        <p role="alert" className="text-sm text-warning">
          {t("groups.failed")}{" "}
          <button type="button" onClick={onRetry} className="underline">
            {t("groups.refresh")}
          </button>
        </p>
      ) : null}
      <fieldset disabled={error || mutation.isPending} className="space-y-3">
        <select
          aria-label={t("groups.filter")}
          value={group?.id ?? ""}
          onChange={(e) => {
            onSelect(e.target.value ? Number(e.target.value) : null);
            setName("");
            setConfirmDelete(null);
            mutation.reset();
          }}
          className="h-10 max-w-full rounded-lg border border-border bg-raised px-3 text-sm"
        >
          <option value="">{t("groups.all")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.addresses.length})
            </option>
          ))}
        </select>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate({ kind: "create", name: name.trim() });
          }}
        >
          <Input
            aria-label={t("groups.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={t("groups.placeholder")}
            className="w-full sm:w-60"
          />
          <Button type="submit" disabled={!name.trim() || groups.length >= 20}>
            {t("groups.create")}
          </Button>
          {group && (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={!name.trim()}
                onClick={() =>
                  mutation.mutate({
                    kind: "rename",
                    id: group.id,
                    name: name.trim(),
                  })
                }
              >
                {t("groups.rename")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirmDelete(group.id)}
              >
                {t("groups.delete")}
              </Button>
            </>
          )}
        </form>
        {group && confirmDelete === group.id && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 p-3 text-xs">
            <p>{t("groups.deleteHint")}</p>
            <Button
              type="button"
              size="sm"
              onClick={() => mutation.mutate({ kind: "delete", id: group.id })}
            >
              {t("groups.confirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setConfirmDelete(null)}
            >
              {t("groups.cancel")}
            </Button>
          </div>
        )}
        {group && (
          <details
            key={group.id}
            className="rounded-lg border border-border p-3"
          >
            <summary className="cursor-pointer text-sm">
              {t("groups.organize")}
            </summary>
            <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {favorites.length ? (
                favorites.map((f) => (
                  <label
                    key={f.address}
                    className="flex min-w-0 items-center gap-2 rounded-lg bg-raised p-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={group.addresses.includes(f.address)}
                      onChange={(e) =>
                        mutation.mutate({
                          kind: e.target.checked ? "add" : "remove",
                          id: group.id,
                          address: f.address,
                        })
                      }
                    />
                    <TraderName
                      trader={{
                        address: f.address,
                        displayName: f.stats?.displayName,
                      }}
                    />
                  </label>
                ))
              ) : (
                <p>{t("groups.noFavorites")}</p>
              )}
            </div>
          </details>
        )}
      </fieldset>
      {mutation.isError && (
        <p role="alert" className="text-xs text-negative">
          {t(
            mutation.error.code === "group_name_exists"
              ? "groups.duplicate"
              : "groups.failed",
          )}
        </p>
      )}
    </Panel>
  );
}
