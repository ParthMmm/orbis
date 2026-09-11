# Read Source metadata from the provider instead of asking the person to type it

A Set saved from a Source Link has a URL and nothing else. Everything a person reads in the Library, a title, a creator, artwork, and a duration, is knowledge the provider already has, so asking for it is asking someone to copy text a machine can fetch.

Enrichment is a `Metadata` service beside the store rather than a step inside it, because the Library is a SQLite store and a provider is a network. The service exposes a single `enrich` operation. Both providers sit in a registry keyed by Source, so a Source with no entry is the not-configured state and no second boolean tracks the same fact. YouTube reads the Data API and needs a key the host holds, in the environment and never in the repository. SoundCloud reads oEmbed and needs nothing. Provider payloads are parsed with an Effect schema where the response body is read, so the code that reads a title takes a typed value and only the response read touches unknown input.

A save enriches only when the request supplies no title. That is what keeps the desktop client's save path free of the network, which it has never had. It posts a typed title, gets a Set back, and works offline. The native flow posts a bare Source Link, so it takes the other branch and receives the provider's title. A supplied title is recorded as edited by the user.

Enrichment never fails a save. A Set whose provider refused or timed out is stored with a failed metadata state and a temporary title, and the client offers to retry. A retry replaces the title only when the user has not edited one, and that decision is made inside the `UPDATE` rather than by reading first, so two writers cannot interleave into a lost edit. The flag is the only record of who chose a title, which is why the migration that introduced it backfills existing rows as edited. Every row that predates the column was written when a title was mandatory, so every one of them holds a title a person typed.

The default layer configures no provider. Tests build the application without naming providers, so a save that omits a title fails enrichment deterministically instead of calling soundcloud.com from inside the unit suite, which is what it did when the default was live. The entrypoint states its providers explicitly.

Rejected alternatives:

- **Enrich on every save, including a save with a typed title.** Records better metadata on the desktop path. Rejected because it puts a network call inside a save that has always been local, so a provider stall would become a stalled save. `docs/plans/native-clients-program.md` lane one of unit U3 originally expected this behaviour and was reworded to match.
- **A per-source branch and a separate configured boolean.** The same facts held twice, and the two can disagree. A registry makes the not-configured state the absence of an entry.
- **Enrich in a background job after the save responds.** The client would have to poll for a title it could have had immediately, and the temporary title becomes visible in the common case rather than the failure case.
- **Let a failure fail the request.** The Set is the user's, the metadata is not. A provider outage would make the library unwritable.
- **Keep the YouTube key in the deployment checkout or the repository.** Rejected because the deployment checkout is a copy of the repository at a branch, so a secret there is one `git status` from being committed. It reaches the service through a systemd `EnvironmentFile` drop-in pointing at the working checkout `~/orbis`, where `.env` files are already ignored.

The trade this accepts is that the library's contents depend on an external service's availability. A Set saved during an outage keeps a temporary title until someone retries it, so titles in one library can be of two different qualities at the same time. The metadata state is exposed for exactly that reason, and the retry action is one tap.
