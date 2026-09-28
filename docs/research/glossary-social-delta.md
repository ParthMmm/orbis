# Glossary delta (social / web) — draft for CONTEXT.md

**Person**:
A member of this Orbis deployment with a username and API keys.
_Avoid_: User, account (in UI copy prefer username / people)

**Group**:
The single private membership set on this deployment. One group per Vanta/Orbis.
_Avoid_: Team, org, server

**Host**:
The operator with god powers: mint/revoke keys, remove people.
_Avoid_: Admin (ok in ops docs)

**Social**:
Per-person master toggle. Off hides you from others and others from you.
_Avoid_: Sharing mode, public mode

**See / Appear**:
Per-other-person knobs. See = include them in your social views. Appear = let them see you.
_Avoid_: Follow, mute (mute implies symmetric)

**Presence**:
The Set a Person is in the middle of a Listen on, plus a short recent strip.
_Avoid_: Now playing only (history is separate)

**Listen History**:
The Person's Listen / Finish record, shown on their profile to allowed viewers.
_Avoid_: Activity feed (implies global firehose)

**Collaborative** (Playlist):
Creator-owned flag that grants editors add/remove/reorder only.

## Existing nouns — clarified

**Library**: still "Sets saved by one Person" — now many Libraries on one server.

**Set**: canonical by source link on the box; many Libraries may point at it.

**Retained Audio**: one per Set/source link on Vanta; streamable by anyone who can see the Set.

**Download**: creates shared Retained Audio for that Set; enqueue allowed if the actor can see the Set.
