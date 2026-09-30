import { isIP } from "node:net";

/**
 * The bucket a client address counts against in per-client limits (rate
 * limits, SSE per-IP caps, the Hyperliquid page budget). An IPv4 address is
 * its own bucket; an IPv6 address counts by its /64, since one subscriber is
 * routinely handed a whole /64 and rotating addresses inside it costs
 * nothing. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is the IPv4 address.
 */
export function clientKey(address: string | undefined | null): string {
  if (!address) return "unknown";
  const zoneless = address.split("%")[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(zoneless);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const version = isIP(zoneless);
  if (version === 4) return zoneless;
  if (version !== 6) return "unknown";
  return `${expandIpv6(zoneless).slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, lowercase, without leading
 * zeros (an embedded IPv4 tail becomes two groups). */
function expandIpv6(address: string): string[] {
  let text = address.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = tail === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16));
}
