import { renderNotFound } from "@/components/shell/not-found-view";

/** Every URL no other route matches. The proxy has answered it 404 (no
 * page in `lib/page-routes.ts` matches), so the 404 is rendered here, in
 * the first HTML, with the status and the 404's title. Every real route
 * outranks a catch-all. */
export default function Missing() {
  return renderNotFound();
}
