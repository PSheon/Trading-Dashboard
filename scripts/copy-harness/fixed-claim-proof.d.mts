/** Historical evidence checker only; does not mint execution authority. */
export type FixedClaimResult = Readonly<{ originalExecutionKey: string; originalLegId: string; tradeKey: string }>;
export type ProofTools = Record<string, (...args: any[]) => any>;
export function createFixedClaimValidator(tools: ProofTools): (input: unknown) => FixedClaimResult | null;
export function fixedClaimEvidenceQuery(candidate: {id?:string;mandateId?:string;sourceFillId?:string;userId?:number;state?:string;reason?:string;leg?:string}, scope:{network:string;leaderNetwork:string;leader:string;follower:string}):string|null;
export function hydrateFixedClaimEvidence(raw:string, options:{candidate:unknown;dispatches:any[];network:string;accountAddress:string;fills:any[];tools:ProofTools;now:number}):unknown;
