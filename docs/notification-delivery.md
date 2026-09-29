# Durable notification delivery

Migrations `0007_notification_outbox` and `0008_action_evaluation_context` must run before starting this API version.
They add tables and an evaluation-context column; it does not enqueue old actions or send historical messages.
Apply the migration once using the deployment migration job. Local verification
uses the isolated test DB only; no production migration has been performed.

Recent live actions and their `action_outbox` intent commit in the same existing
address-lock transaction. Backfill and corrections do not enqueue alerts.
The in-memory event keeps low latency; the five-second outbox poll recovers missed
events. Rule evaluation serializes by chain/address/coin and commits cooldown
reservations, recipient delivery intents and evaluation completion together.
The action intent captures available equity for percentage rules; replay uses this
snapshot even when watcher memory is empty. Unknown equity retains the flat
threshold fallback. Favorite cooldown is durable across restarts; rule cooldown also consults legacy
alert rows for compatibility.

`notification_outbox` has one row per action/recipient. Alerts start as pending;
a claimed sender updates the same rows after the attempt. Atomic claims use a
five-minute lease; abandoned leases can be reclaimed. Evaluation/delivery each
get at most five claims before terminal failure. Each delivery claim retains the
existing bounded Telegram retry policy; Retry-After over one minute is persisted
as a future available time instead of keeping a worker asleep. Failed transient
attempts retry after at least one minute. Completed and terminal failed rows are
retained for investigation; retention automation remains a separate task.

Before every external attempt, including retries, check current account status, Telegram destination, favorite
subscription/filters or admin role, and the global notification switch. Removing
or disabling the original Telegram destination does not redirect an old message
to a new chat. Messages include their original action timestamp, so delayed
recovery does not present an old trade as current.

`GET /admin/outbox` requires `admin.access` and returns aggregate counts by status
for evaluations and deliveries, without payloads or Telegram identifiers.
Investigate terminal failures before an operator resets a row to pending. Do not
blindly reset sent rows. There is no public retry endpoint in this batch.

Delivery is **at least once**, not exactly once: Telegram can accept a message
before the process records success. A crash in that gap can cause one duplicate
when a lease is reclaimed. Database uniqueness prevents duplicate intents, not
that external side-effect ambiguity. No transaction is held across Telegram HTTP.
Single-replica watcher/poller deployment remains the supported topology.
