/** Structured data for search engines, rendered into the page's HTML as
 * Next's JSON-LD guide recommends. `<` is escaped so no value can close the
 * script element. A data block is not executed, so the CSP nonce does not
 * apply to it. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
