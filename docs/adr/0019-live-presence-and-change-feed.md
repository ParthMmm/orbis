# Live Presence comes from playback actions and changes use a private resumable feed

This decision follows the completed cutover in ADR 0018. It defines future work and changes no current behavior. Implementation remains tracked by the linked spec and its sub-issues.

A Person's friends need accurate Presence, and their own devices need fresh Library and Playlist views. Playback Position reports currently imply Presence for 30 seconds. Every event stream re-reads Presence every two seconds. A pause refreshes the report and looks like playing until it expires.

## Presence follows actual playback

New clients report actual audio play, pause, Set change, and stop immediately through an additive authenticated action route. An intentional play that fails to start audio does not create live Presence. Pausing clears the explicit session from live Presence immediately. A valid legacy report from another device can still supply that Person's Presence during compatibility rollout. The Set remains eligible for the recent strip through its existing Listen. There is no public paused badge or indefinite paused Presence. This preserves ADR 0009.

Play acquisition checks the active Listening Queue Set and commits ownership in one conditional transaction. If Queue activation changes first, acquisition returns a conflict and the client re-reads the Queue before reporting actual playback again. Queue changes clear any explicit owner for a different active Set within their mutation transaction.

Playback actions do not create Listens or Finishes. The existing Listening Queue and Listen operations remain their only owners. A seek does not create a Listen. A resume continues the same Listen. Automatic Queue advance retains its existing Listen and Finish rules.

A live session belongs to a Person and their daily key. The Group accepts play acquisition in its own order and returns an ownership generation. The most recently accepted actual play owns live Presence. Pause, stop, and renewal require that generation. A stale device cannot clear or renew a newer device's Presence. Each client session has increasing action numbers and unique action IDs so delayed messages and retries cannot undo a newer action in that session. Persist deduplication results under `(key ID, session ID, action ID)` for seven days. Within the seven-day result-retention window, reusing an action ID with different input is a conflict. Persist each session's highest accepted action number until its key is revoked. After a result is pruned, an action at or below that number returns a stale-action refusal and cannot acquire another generation. Reusing a pruned action ID with a new higher action number is a new action; the conflict guarantee does not extend beyond seven days.

New clients renew a playing session every 15 seconds. A renewal extends a 30-second lease using server time. An alarm removes expired Presence without per-stream polling. Persist the session, its generation, and its deadline in Group storage so hibernation does not lose a live session. Playback Positions remain independent of that lease. A renewal without a visible state change emits no event and consumes no delivery sequence.

Keys opt into explicit Presence when they first acquire a session. After opt-in, their Position reports never create or renew Presence. Older keys keep the existing Position-based inference and expiry. A legacy report cannot take ownership while an explicit playing lease is live. Store legacy reports by daily key, replacing the current per-Person report map. Without an explicit playing owner, the most recent unexpired legacy report from a non-opted-in key supplies Presence. Pausing an explicit owner clears that session; another still-valid legacy report may then supply Presence. Revoking a key clears its explicit sessions and legacy reports in the same transaction. Removing a Person clears every owned session and report. Both transitions journal only currently permitted resets. This compatibility path stays until every supported client can report actions. Upgraded clients continue saving Playback Positions at the existing rate.

## Changes push once through the same visibility gate

A Presence action, an expiry, a Queue change, or a visibility change triggers delivery after its state change commits. There is no two-second Presence re-read in the new feed. Build visible snapshots through the same ADR 0009 resolver that HTTP uses.

The feed carries these topics:

- The caller's Listening Queue and live visible Presence.
- Changes to the caller's Library Entries, Tags, and Playback Positions on another device.
- Collaborative Playlist edits for the creator and editors who still have read access.
- New Listens and Finishes as invalidations of an already-visible Person's Listen History and recent strip.

Library, Playlist, and Listen History events are invalidations. Clients re-read their normal authorized routes. Events never copy another Person's Library Entry or full Listen History into a durable event payload. Shared Set metadata changes invalidate views that can currently read that Set. Tracklist changes may later use that general Set invalidation; this decision adds no Tracklist implementation.

## Catch-up uses one sequence per recipient

The Group assigns one increasing delivery sequence per Person across all topics. It does not expose a Group-wide write counter. Hidden writes therefore produce neither a delivery nor a sequence gap for an unrelated Person.

Each domain mutation owner commits its state and eligible-recipient journal entries in one SQLite transaction. Queue and Stats currently write separately; implementation must combine their related Queue, Listen, and Finish updates under one transaction before publishing their feed changes. Library, Playlist, visibility, and trust mutations use the same journal interface inside their existing transaction. This is one commit boundary per logical mutation, not a second asynchronous publisher. The mutation and its eligible-recipient journal entries commit together in SQLite. Each entry records a minimal topic and resource reference. A Person is eligible only if they can read the affected resource when the change commits. The server rechecks that access before replay or live delivery. Gaining access later does not replay activity from before access existed.

Clients resume with an opaque cursor tied to their Person, key, and authorization epoch. Replayed invalidations can collapse by resource. Queue and Presence replay as fresh authorized snapshots rather than old playback states. Delivery is at least once, and clients deduplicate by cursor. The client records its resume cursor only after applying a message. An interrupted catch-up can safely retry.

Retain at most seven days and 10,000 deliveries per Person, whichever bound removes an entry first. An expired cursor, a cursor from another key, an authorization-epoch change, or a backup restore produces a reset response and fresh snapshots. Snapshot construction and the starting cursor use one consistent storage view. The server buffers or journals subsequent writes before live delivery, so reconnect cannot miss a write between snapshot and subscription.

A visibility reduction sends a generic reset to affected authorized clients and invalidates their resume epoch. That message names no newly hidden Person or resource. Clients clear their social cache before re-reading. The server removes unsent forbidden deliveries, rechecks replay access, and terminates revoked-key sockets immediately. A removal or filter change cannot leave already-open streams with stale permission.

## Add a hibernating WebSocket feed and retain existing SSE

Keep `GET /events` and its current event union for old clients. It keeps the 30-second heartbeat and reads the shared current Presence state. Add a separate opt-in feed contract for new clients. New web and Apple clients prefer its WebSocket transport and can use an authenticated fetch-read SSE transport with the same new messages when WebSocket upgrade is unavailable.

A daily key requests a short-lived, single-use connection ticket through an authenticated POST. The ticket names the key, Person, authorization epoch, and feed protocol. A ticket is accepted only for the client feed upgrade, expires after 30 seconds, and cannot call any HTTP API. Never put the daily key in a URL. Redact ticket values from request logs, set no-store on ticket responses, validate browser Origin at upgrade, and reject node-scope keys. Native clients use the same ticket flow.

Accept client sockets with the Hibernation API under a separate client-feed tag. Store the minimal connection identity in serialized attachments and recheck current authorization before delivery. Durable feed state belongs in storage, not attachments. Recover subscriptions after eviction. Keep the audio-node dispatch separate. An optional fixed transport ping can use automatic responses, but cannot renew a playback lease or prove authorization.

Quiet feed sockets can hibernate. Active playback renewals and lease alarms still wake the Group, and legacy SSE connections still keep it awake. This decision promises no zero-cost active playback. Cloudflare documents the socket persistence and attachment behavior in [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Alternatives

A direct SSE-only design could eliminate Presence polling with fewer transport changes. It would still keep the Group awake for every quiet open client. Keep it as the new feed's fallback and the old contract's compatibility path.

A Group-wide sequence would give one simple journal order but reveal otherwise hidden write counts. Per-recipient delivery sequences preserve a single cursor for each client without disclosing Group activity.

A permanently visible paused session would keep a Set on screen but publish activity after listening stopped. The recent strip already supplies that context, and ADR 0009 makes live Presence mean a current Listen with active playback.

A socket-close signal alone cannot determine Presence. A background player may keep playing after its feed reconnects, and a closed app may never send stop. Actions and a bounded lease cover both cases.

## Acceptance

Publish the linked spec and implementation sub-issues now that #195 is complete. Verify direct delivery, lease expiry, replay, permission changes, mixed old and new clients, and hibernation through actual HTTP and Worker runtime journeys. Keep repeatable traces and UI screenshots with credentials removed.
