import { NotFoundView } from "@/components/shell/not-found-view";
import { getLocale, getMessages } from "@/i18n/server";
import { APP_NAME } from "@/lib/config";

/** The 404 for a `notFound()` thrown while a page renders: an address
 * Hyperliquid has nothing for, a name that is no market. In this Next the
 * server answers those with an empty error document and the browser
 * renders this once it hydrates (404s the proxy can decide are rendered by
 * their page instead: see `lib/page-routes.ts`). A not-found file can't
 * export metadata, so the title is rendered here and React moves it into
 * the head, ahead of the layout's. */
export default async function NotFound() {
  const m = getMessages(await getLocale());
  return (
    <>
      <title>{`${m.meta.notFound} | ${APP_NAME}`}</title>
      <NotFoundView />
    </>
  );
}
