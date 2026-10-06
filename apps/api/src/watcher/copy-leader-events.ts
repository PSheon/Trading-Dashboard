/** The trade feed saw a leader that a running copy follows on mainnet trade
 * (worker process, in-process event). A trigger only: the copy engine
 * reads the fill itself over REST. */
export const COPY_LEADER_TRADED_EVENT = "copy.leader.traded";
export interface CopyLeaderTradedEvent {
  address: string;
  /** Exchange time of the trade (ms). */
  time: number;
  tid: number;
}

/** A copied leader's catch-up finished: its verified span (`fill_coverage`)
 * moved, so the copy stream can be audited against it. */
export const COPY_LEADER_VERIFIED_EVENT = "copy.leader.verified";
export interface CopyLeaderVerifiedEvent {
  address: string;
}
