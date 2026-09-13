# Plan 001: Separate local and proxied authentication policies

> **Executor instructions:** Read this file fully, then follow each step and its verification gate. Stop on the conditions below; do not improvise. This is a handoff, not permission to deploy. Update only this plan's status row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/server/src/identity.ts apps/server/src/identity.test.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/src/test-http.ts apps/server/src/listeners.ts apps/server/src/listeners.test.ts deploy/orbis-server/orbis-server.service deploy/orbis-server/README.md docs/adr/0004-native-service-identity.md plans/README.md` and `git diff --stat -- apps/server/src/identity.ts apps/server/src/identity.test.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/src/test-http.ts apps/server/src/listeners.ts apps/server/src/listeners.test.ts deploy/orbis-server/orbis-server.service deploy/orbis-server/README.md docs/adr/0004-native-service-identity.md plans/README.md`. Compare the current-state excerpts with the live code. A commit diff alone misses uncommitted changes. Expected predecessor changes described below are allowed; unexplained semantic drift means STOP.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — changing ingress wiring can lock out clients or leave a bypass if the proxy still targets the local listener
- **Depends on:** none
- **Category:** security
- **Audit finding:** 1; high confidence in the code behavior, deployment exposure not tested
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/server/src/identity.ts`
- `apps/server/src/identity.test.ts`
- `apps/server/src/app.ts`
- `apps/server/src/index.ts`
- `apps/server/src/test-http.ts`
- `apps/server/src/listeners.ts`
- `apps/server/src/listeners.test.ts`
- `deploy/orbis-server/orbis-server.service`
- `deploy/orbis-server/README.md`
- `docs/adr/0004-native-service-identity.md`

`plans/README.md` is also allowed, only to update this plan's status. Preserve all pre-existing changes; compare the executor's diff with its recorded start state, not with an assumption that every dirty file belongs to this task.

## Git workflow

Work in an owner-approved isolated checkout, with one writer per checkout. Suggested branch: `advisor/001-proxy-authentication-boundary`. Do not stash, reset, or copy away the owner's concurrent work. Do not install dependencies, commit, push, or open a PR without separate permission. Existing commit style is conventional, for example `fix(app): ask before forgetting the device`. Missing tools or dependencies are blockers, not permission to install them.

## Why this matters

A caller-controlled Host header currently grants token-free access. Tailscale Serve's upstream HTTPS routing uses TLS SNI and its HTTP proxy preserves the incoming Host for TCP backends. A tailnet peer may therefore present a loopback Host and avoid device authentication. This plan makes the selected listener, not a request header, decide whether token-free local access is permitted. It preserves the Electron main process's existing local behavior.

## Current state

- `apps/server/src/identity.ts:103–125` owns the access decision. Origin rejection precedes bearer validation; only the final branch allows local access:
  ```ts
  if (LOOPBACK_HOST.test(input.host)) {
    return { kind: "local" };
  }
  ```
- `apps/server/src/app.ts:299–315` reads `request.headers.get("host") ?? new URL(request.url).host` and passes it to `decideAccess`. Its wrapper logs refusals and then calls the Effect HTTP handler. Preserve that one decision/logging path.
- `apps/server/src/index.ts:20–25` creates one Bun listener with `hostname: "127.0.0.1"`, `maxRequestBodySize: 65_536`, and `fetch: (request) => app.handler(request)`.
- `deploy/orbis-server/README.md` maps external HTTPS port 8444 to local port 4310. External 443 is occupied; 8443 belongs to an unrelated Funnel. Do not change either.
- ADR 0004 says: “A request with no such header is accepted when its Host is loopback, which is exactly the rule the Electron client relies on.” Update the mechanism explicitly while retaining local token-free access, digest-only device storage, rejection of every Origin header, and immediate revocation. Accepted bearer replay until revocation is not part of this fix.
- `CONTEXT.md`: “Library: The complete collection of Sets saved by one person.” Do not log Library contents or credential material.
- `identity.test.ts` uses temporary trust stores, the `request` helper, and `try/finally` disposal. Match that pattern; generate fixture credentials in memory rather than copying a user's token.

The audit tree already had logging simplification and lazy trust-store reads in `app.ts`, and formatting changes in `index.ts`. Preserve these. Baseline SHA-256 values were `3fbedda4441beb6d7a9b2fca7f5e196e60bb3b0ad49b4150c1f01d2b6a3f9cf5` for `app.ts` and `81082c0fd35d414345bf3d7b19782d8bebe16fdc072d4da96610e709120c8dad` for `index.ts`. Hash differences require comparison, not restoration.

## Commands you will need

Run from repository root unless stated otherwise.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Existing auth tests | `bun test apps/server/src/identity.test.ts` | All pass before changes |
| New listener tests | `bun test apps/server/src/listeners.test.ts` | All pass after the file exists |
| Server suite | `bun test apps/server/src` | All tests pass |
| Full existing JS/TS gates | `bun run check:force` | Exit 0; no diagnostics |
| Whitespace | `git diff --check` | Exit 0 |

Use Bun 1.4.1 and the existing Bun test runner. Before writing Effect code, run `effect-solutions list` and `effect-solutions show basics error-handling services-and-layers`; check APIs in `apps/server/node_modules/effect/src`. Do not install the test framework suggested by a generic guide: this repository uses `bun:test`.

## Out of scope

No Apple or Electron changes, token rotation, device enrollment, credentials inspection, database migrations, reverse-proxy replacement, TLS changes, rate limiting, or runtime Vanta changes. Do not touch Raycast, URL normalization, or shared-contract work. Do not use source IP alone: the local proxy also connects from loopback. Do not trust a caller-supplied forwarded/header flag to select an ingress policy.

## Steps

### Step 1: Establish the local baseline and confirm the threat model

Run the drift checks and auth tests. The upstream context pointer is `https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go`, specifically `getServeHandler` and the reverse-proxy Host rewrite. A pinned upstream revision was not retained during the audit. If read-only web access is available, record the immutable revision you inspect in the ADR amendment; otherwise label this upstream observation unpinned and rely on the local listener regression and separately approved deployment checks. Do not make a moving main branch or an unavailable web fetch a prerequisite for the repository fix. No Vanta access is required. If the owner separately permits read-only Vanta inspection, record installed Tailscale version and Serve route only; never dump environment variables, trust-store contents, or source responses.

**Verify:** `bun test apps/server/src/identity.test.ts` → all pass. `git status --short` → no changes caused by this step. If the deployed proxy demonstrably overwrites Host, report that reduced exposure; retain a clear distinction between hardening and a confirmed deployment defect.

### Step 2: Add a trusted ingress policy to the existing handler

Define an internal exported type `AccessMode = "local" | "device"` in `identity.ts`. Require it in `decideAccess` input. Keep the current ordering: Origin → supplied Authorization → optional local fallback. The loopback Host branch is allowed only for `mode === "local"`; missing credentials in device mode receive the existing 403, regardless of Host. Supplied invalid credentials still receive 401, including on local mode.

Extend the returned app handler to `handler(request: Request, mode: AccessMode = "local")`. This argument comes only from trusted application wiring, never request headers or URL parameters. Preserve one SQLite/Effect app and one logging wrapper. Extend `test-http.ts` with an optional `accessMode` test option passed as the second handler argument; existing tests keep their default.

Add auth cases for device-mode requests with `localhost`, `127.0.0.1`, ports, and a URL authority different from the explicit Host. Missing/invalid credentials must not gain access. Keep local behavior, valid device access, Origin rejection, missing/corrupt registry handling, and immediate revocation tests.

**Verify:** `bun test apps/server/src/identity.test.ts` → all old and new cases pass; device-mode loopback Host without a credential returns 403.

### Step 3: Wire separate loopback listeners with shared storage

Create `listeners.ts` to own Bun listener startup and shutdown, called by `index.ts`. Local port remains `ORBIS_PORT` (default 4310), forwarding with mode `local`. Optional `ORBIS_DEVICE_PORT` enables a second loopback listener forwarding with mode `device`. Set it to 4311 in the deployment unit, not globally in tests or local developer commands. Never bind either listener to a non-loopback interface.

Both listeners use the 65,536-byte body limit and the same app handler. Validate configured ports before binding: local port allows 0 for test allocation, device port must be an integer in 1–65535 when configured, and an explicit same nonzero port is an error. Expose the starter so tests can directly request ephemeral ports for both listeners without weakening environment validation. On partial startup failure, close any listener already opened. On shutdown, stop all listeners before disposing the shared app exactly once. Keep current SIGINT/SIGTERM behavior.

Add `listeners.test.ts` with real loopback sockets, a temporary database/trust store, and generated fixture credentials. Request the device listener with an explicit loopback Host and no token: 403. Local no-token request: 200. Paired device: 200; Origin: 403. Write a titled Set through one listener and read it through the other to prove shared storage without provider calls. Cover disabled device listener, invalid configuration, body-limit parity, occupied second port cleanup, and shutdown. All sockets must close in `finally`.

**Verify:** `bun test apps/server/src/listeners.test.ts apps/server/src/identity.test.ts` → all pass and the test process exits without open listeners.

### Step 4: Document the required proxy cutover and its safety gate

Amend ADR 0004 to distinguish local versus proxied ingress without claiming live exploit verification. Add `Environment=ORBIS_DEVICE_PORT=4311` to the unit and change the documented Serve target to `http://127.0.0.1:4311`. Keep HTTPS 8444, loopback 4310 for Electron, and all unrelated mappings unchanged.

Document an owner-run cutover: confirm the device listener works locally; replace only the Orbis Serve target; verify from a different tailnet node. State that shipping the code without switching Serve away from 4310 does NOT close the suspected bypass. Owner-run negative check:

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  -H 'Host: localhost:4310' https://vanta.tail01d084.ts.net:8444/health
```

Expected after cutover: 403, never 200. A normal no-token request must also return 403, an invalid token 401, and a paired device 200. For the positive check, use the owner's existing secret-injection mechanism without echoing tokens, adding them to shell history, or saving response payloads. If a safe injection mechanism is unavailable, stop rather than invent one. The external URL/SNI stays the tailnet host even when Host is overridden.

Never run the cutover as part of this plan's repository execution. If rollout validation fails, disable only the Orbis Serve rule rather than restoring a token-free proxy target. Leave local access and stored data intact. Record rollout status separately from repository completion.

**Verify:** `bun run check:force && git diff --check` → exit 0. Review `git diff -- deploy/orbis-server docs/adr/0004-native-service-identity.md` → device mode targets 4311, external port remains 8444, no credential values or unrelated mappings appear.

## Test plan

Use existing auth fixtures plus the real-socket tests above. Exercise both HTTP authority and explicit Host variants; an in-process policy test alone does not prove the Bun listener passes the correct mode. Require the same application instance for both listeners, immediate device revocation, invalid supplied credentials never falling back to local access, and cleanup after partial startup failure.

## Done criteria

- [ ] Auth and listener test commands exit 0, including spoofed Host rejection on device ingress.
- [ ] `bun run check:force` and `git diff --check` exit 0.
- [ ] Both configured sockets bind only loopback and share one app/database lifecycle.
- [ ] The unit, deployment guide, and ADR agree on the separate device listener.
- [ ] No executor-created changes lie outside Scope; the index row records repository status and explicitly says whether live rollout remains unverified.

## STOP conditions

Stop for unexplained drift, failure of a gate twice after a reasonable fix, unavailable dependencies, or need to edit an out-of-scope file. Stop if separate ingress cannot preserve local Electron access, if the port choice conflicts with Vanta services, or if changing proxy configuration requires touching another service. Do not claim the deployed issue is fixed without the owner's negative and positive external checks. Do not substitute an untrusted header or loopback source-address test for listener isolation.

## Maintenance notes

Any future listener/proxy change must preserve the rule that remote traffic never reaches token-free ingress. A reviewer should scrutinize default modes, partial-start cleanup, body limits, and the deployment target. Service restart instructions and Bun version alignment are a separate selected plan, 002; do not silently incorporate that work here.
