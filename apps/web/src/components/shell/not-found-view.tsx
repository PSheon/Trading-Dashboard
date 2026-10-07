import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { OrbieMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button-variants";
import { Link } from "@/i18n/navigation";
import { getLocale, getMessages } from "@/i18n/server";
import { NOT_FOUND_HEADER } from "@/lib/page-routes";

/** The 404 (C-404): the Orbie planet, a large "404", one line, and 返回首頁
 * (home). A server component: Button keeps busy state (hooks), so the link
 * takes its look from buttonVariants. */
export async function NotFoundView() {
  const m = getMessages(await getLocale());
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <OrbieMark size={140} className="orbit-float" />
      <h1 className="num mt-4 font-display text-[7.5rem] leading-none">{m.notFound.title}</h1>
      <p className="mt-4 text-lg font-bold text-muted-foreground">{m.notFound.body}</p>
      <Link href="/" data-slot="button" className={buttonVariants({ size: "cta", className: "mt-5" })}>{m.notFound.home}</Link>
    </div>
  );
}

/**
 * A 404 the proxy already answered (see `isStaticNotFound`): the status is
 * 404 and the root layout's metadata titles the tab, so the page renders
 * the 404 itself and it is in the first HTML. Without the proxy's mark
 * (a request the proxy doesn't see) it is the ordinary `notFound()`.
 */
export async function renderNotFound() {
  if ((await headers()).get(NOT_FOUND_HEADER) !== "1") notFound();
  return <NotFoundView />;
}
