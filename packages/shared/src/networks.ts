import { z } from "zod";
import { HYPERLIQUID_NETWORKS } from "./wallet-networks.js";

/** A Hyperliquid network on the wire: one schema for the hand-written
 * `z.enum(['testnet', 'mainnet'])` copies (architecture review E3 #1). */
export const networkSchema = z.enum(HYPERLIQUID_NETWORKS);
