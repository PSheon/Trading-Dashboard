import { notFound } from "next/navigation";

/** Every URL no other route matches. Without this Next answers those from
 * its own fallback, where the title not-found.tsx renders loses to the
 * layout's once the page hydrates; as a route that calls notFound(), an
 * unmatched URL gets the same 404 — status, page and tab title — as a
 * missing trader or market. Every real route outranks a catch-all. */
export default function Missing(): never {
  notFound();
}
