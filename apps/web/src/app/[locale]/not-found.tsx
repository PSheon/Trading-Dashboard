import { Link } from "@/i18n/navigation";

import { OrbieMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { getLocale, getMessages } from "@/i18n/server";
import { APP_NAME } from "@/lib/config";

/** The 404 (C-404): the Orbie planet, a large "404", one line, and 返回排行榜 (home), with
 * the tab reading "<page not found> | <site>" as CopyDog's does. A 404 is
 * rendered with the layouts' metadata (a not-found file can't export any,
 * and the metadata of the page that called notFound() is dropped), so the
 * title is rendered here: React moves it into the head, ahead of the
 * layout's, and the first title is the one browsers and crawlers read. */
export default async function NotFound() {
  const m = getMessages(await getLocale());
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <title>{`${m.meta.notFound} | ${APP_NAME}`}</title>
      <OrbieMark size={140} className="orbit-float" />
      <h1 className="num mt-4 font-display text-[7.5rem] leading-none">{m.notFound.title}</h1>
      <p className="mt-4 text-lg font-bold text-muted-foreground">{m.notFound.body}</p>
      {/* A server component: Button keeps busy state (hooks) since cac59908,
          so the link takes its look from buttonVariants instead. */}
      <Link href="/" data-slot="button" className={buttonVariants({ size: "cta", className: "mt-5" })}>{m.notFound.home}</Link>
    </div>
  );
}
