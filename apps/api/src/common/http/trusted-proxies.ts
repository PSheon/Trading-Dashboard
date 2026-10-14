import { BlockList, isIP } from "node:net";

/** Whether an address is in API_TRUSTED_PROXY_CIDRS (Express `trust proxy`); `::ffff:`
 * peers match their IPv4 entries; an empty list trusts nothing. */
export function trustedProxyMatcher(cidrs: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, mask] = cidr.split("/");
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (mask === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(mask), type);
  }
  return (address) => {
    if (!address || cidrs.length === 0) return false;
    const plain = address.split("%")[0].replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
    const version = isIP(plain);
    return version !== 0 && list.check(plain, version === 6 ? "ipv6" : "ipv4");
  };
}
