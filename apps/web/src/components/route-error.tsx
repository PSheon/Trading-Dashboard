"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * What a route shows when rendering it threw: one line, 重試 and the way
 * home, laid out like the 404 (CopyDog shows no more than that on a failed
 * page; nothing about the error itself is printed, and in production the
 * message is not sent to the browser anyway). The error goes to the
 * console, with its digest, for whoever is debugging.
 */
export function RouteError({ error, retry, title, retryLabel, homeLabel }: {
  error: Error & { digest?: string };
  retry: () => void;
  title: string;
  retryLabel: string;
  homeLabel: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button className="h-12 rounded-[12px] px-4 text-base font-medium" onClick={() => retry()}>
          {retryLabel}
        </Button>
        <Button asChild variant="secondary" className="h-12 rounded-[12px] px-4 text-base font-medium">
          <Link href="/">{homeLabel}</Link>
        </Button>
      </div>
    </div>
  );
}
