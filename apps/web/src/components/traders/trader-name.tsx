import { cn } from "cn";

import { splitAddress } from "@/lib/format";

/**
 * A shortened address in the mono face ("0x30af…393e"). When the space is
 * narrower still, only the head is cut ("0x30…393e"): the tail stays and
 * there is never a second ellipsis. The full address is the tooltip.
 */
export function AddressText({ address, className }: { address: string; className?: string }) {
  const { head, tail } = splitAddress(address);
  return (
    <span className={cn("inline-flex max-w-full min-w-0 whitespace-nowrap num", className)} title={address}>
      <span className="min-w-0 truncate">{head}</span>
      {tail ? <span className="shrink-0">{tail}</span> : null}
    </span>
  );
}

/** A trader's display name (cut with an ellipsis when too long), or their
 * address as `AddressText`. */
export function TraderName({
  trader,
  className,
}: {
  trader: { displayName?: string | null; address: string };
  className?: string;
}) {
  const name = trader.displayName?.trim();
  if (!name) return <AddressText address={trader.address} className={className} />;
  return (
    <span className={cn("block min-w-0 truncate", className)} title={name}>
      {name}
    </span>
  );
}
