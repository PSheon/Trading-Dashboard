import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getLocale, getMessages } from "@/i18n/server";
import { APP_NAME } from "@/lib/config";

/** CopyDog's 404: a large "404", one line, and 返回排行榜 (its home), with
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
      <h1 className="num text-6xl leading-none font-bold">{m.notFound.title}</h1>
      <p className="mt-4 text-lg text-muted-foreground">{m.notFound.body}</p>
      <Button asChild className="mt-8 h-12 rounded-[12px] px-4 text-base font-medium">
        <Link href="/">{m.notFound.home}</Link>
      </Button>
    </div>
  );
}
