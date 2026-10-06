"use client";

import { useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";

/**
 * 登出, with its busy state, and a failure said instead of an unhandled
 * rejection (Privy's logout can reject: the network, its iframe).
 */
export function useLogout(): { logout: () => Promise<void>; pending: boolean } {
  const { logout } = useAuth();
  const toast = useToast();
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  return {
    pending,
    logout: async () => {
      if (pending) return;
      setPending(true);
      try { await logout(); }
      catch { toast.error(t("common.errors.failed")); }
      finally { setPending(false); }
    },
  };
}
