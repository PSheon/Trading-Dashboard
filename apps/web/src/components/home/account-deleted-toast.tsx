"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/provider";

/**
 * After a self-service deletion the dialog lands here with
 * `?accountDeleted=1`: the person is told once that the account is gone,
 * and the flag leaves the address (a reload or a shared link says nothing).
 */
export function AccountDeletedToast() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const toast = useToast(), t = useT();
  const shown = useRef(false);
  const deleted = params.get("accountDeleted") === "1";
  useEffect(() => {
    if (!deleted || shown.current) return;
    shown.current = true;
    toast.success(t("deleteAccount.done"));
    const rest = new URLSearchParams(params.toString());
    rest.delete("accountDeleted");
    router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [deleted, params, pathname, router, t, toast]);
  return null;
}
