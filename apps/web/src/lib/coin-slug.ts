/**
 * Coin page URLs as CopyDog writes them: `/coins/BTC`, and a HIP-3 market's
 * dex prefix joined with a dash instead of Hyperliquid's colon
 * (`xyz:TSLA` → `/coins/xyz-TSLA`). Dex names are lowercase and coin names
 * never contain a dash, so the mapping is reversible.
 */
export function coinSlug(coin: string): string {
  return coin.replace(":", "-");
}

/** The Hyperliquid coin a slug names ("xyz-TSLA" → "xyz:TSLA"); null when
 * it can't be one. */
export function coinFromSlug(slug: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(slug);
  } catch {
    // "%E0%A4%A": not valid percent-encoding, so not a coin.
    return null;
  }
  const dex = /^([a-z0-9]{1,12})[-:]([A-Za-z0-9]{1,20})$/.exec(value);
  if (dex) return `${dex[1]}:${dex[2]}`;
  return /^[A-Za-z0-9]{1,20}$/.test(value) ? value : null;
}

export function coinHref(coin: string): string {
  return `/coins/${coinSlug(coin)}`;
}
