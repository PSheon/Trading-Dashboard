"use client";

import { onlineManager } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import { skeletonItem } from "./skeleton-items";

/** The fixture trader the browser suite also uses. */
export const SAMPLE_TRADER = "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";

const subscribe = () => () => {};

/**
 * One gallery item, alone in its frame (/<locale>/dev/skeletons/<id>):
 * `?state=skeleton` holds the network so the component stays in its loading
 * state; `?state=loaded` lets it read its data. `?theme=light|dark` paints
 * the frame without touching the visitor's saved theme. Rendered in the
 * browser only (the server never pauses anything).
 */
export function SkeletonFrame({ id }: { id: string }) {
  const params = useSearchParams();
  const loaded = params.get("state") === "loaded";
  const theme = params.get("theme");
  const address = params.get("address") || SAMPLE_TRADER;
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  // Before any query mounts: an offline client keeps every query pending.
  useState(() => {
    if (typeof window !== "undefined" && !loaded) onlineManager.setOnline(false);
  });
  useLayoutEffect(() => {
    if (theme !== "light" && theme !== "dark") return;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);
  const item = skeletonItem(id);
  if (!item || !mounted) return null;
  return <div data-gallery-frame={id} data-state={loaded ? "loaded" : "skeleton"}>{!loaded && item.skeleton ? item.skeleton({ address }) : item.view({ address })}</div>;
}
