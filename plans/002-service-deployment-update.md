# Plan 002: Restart the API on deployment updates and align Bun

> **Executor instructions:** Read this file fully, then follow each step and its verification gate. Stop on the conditions below; do not improvise. This is a handoff, not permission to deploy. Update only this plan's status row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- deploy/orbis-server/README.md deploy/orbis-server/orbis-server.service plans/README.md` and `git diff --stat -- deploy/orbis-server/README.md deploy/orbis-server/orbis-server.service plans/README.md`. Compare the current-state excerpts with the live code. A commit diff alone misses uncommitted changes. Expected predecessor changes described below are allowed; unexplained semantic drift means STOP.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — documentation/unit changes; a later approved restart briefly interrupts requests
- **Depends on:** none; serialize with 001 because both edit the deployment files
- **Category:** docs
- **Audit finding:** 2; high confidence
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `deploy/orbis-server/README.md`
- `deploy/orbis-server/orbis-server.service`

`plans/README.md` is also allowed, only to update this plan's status. Preserve all pre-existing changes; compare the executor's diff with its recorded start state, not with an assumption that every dirty file belongs to this task.

## Git workflow

Work in an owner-approved isolated checkout, with one writer per checkout. Suggested branch: `advisor/002-service-deployment-update`. Do not stash, reset, or copy away the owner's concurrent work. Do not install dependencies, commit, push, or open a PR without separate permission. Existing commit style is conventional, for example `fix(app): ask before forgetting the device`. Missing tools or dependencies are blockers, not permission to install them.

## Why this matters

The “Install or update” recipe pulls new code but uses `systemctl --user enable --now`, which does not restart an already-running service. An operator can believe an update is active while clients still talk to the old process. The unit also points at Bun 1.4.0 while the repository and CI use 1.4.1. A clear restart and runtime preflight make deployment repeatable.

## Current state

- `deploy/orbis-server/README.md:24–34` runs:
  ```sh
  bun install --frozen-lockfile
  bun run --filter @orbis/contracts build
  mkdir -p ~/.config/systemd/user
  cp deploy/orbis-server/orbis-server.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now orbis-server
  systemctl --user status orbis-server --no-pager
  ```
- `deploy/orbis-server/orbis-server.service:10` has:
  ```ini
  ExecStart=%h/.local/share/mise/installs/bun/1.4.0/bin/bun src/index.ts
  ```
- Root `package.json` declares `"packageManager": "bun@1.4.1"`; `.github/workflows/quality.yml` installs 1.4.1.
- The service runs source directly with its working directory at `~/orbis-service/apps/server`; `@orbis/contracts` still needs its package build. Data lives separately at `~/orbis-service-data`. Provider credentials are supplied through an existing systemd drop-in; leave them there.
- ADR 0004 requires loopback binding and per-device credentials for remote access. Plan 001 may add a device listener and change the documented proxy target; preserve those predecessor changes.
- `CONTEXT.md`: a Set is “A saved music recording or DJ performance identified by its source link.” No update check should save or delete a Set in the live Library.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Check declared runtime | `bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).packageManager)'` | `bun@1.4.1` at the planning baseline |
| Check unit runtime | `grep '^ExecStart=' deploy/orbis-server/orbis-server.service` | Version agrees with the manifest |
| Check doc commands | `sed -n '/^## Install or update/,/^## Enrol a device/p' deploy/orbis-server/README.md` | Reload, enable, explicit restart, and status checks appear in the update recipe |
| Whitespace | `git diff --check` | Exit 0 |

No install, service command, or SSH session is needed to edit these two files. Linux-only validation belongs on Vanta with separate owner permission, not on the Mac.

## Out of scope

No actual deploy, runtime install, git pull, service restart, proxy edit, provider credential inspection, database backup/restore, health response contract, or CI change. Do not alter service hardening settings or update dependencies. No generic deployment automation framework.

## Steps

### Step 1: Confirm the pin and update the unit

Run drift checks. Read the manifest and CI Bun version. If they disagree, stop and ask the owner which version is intended. If both still say 1.4.1, change only the Bun version component in `ExecStart` to 1.4.1. Preserve all other settings, including the optional device listener introduced by plan 001.

**Verify:** `grep '^ExecStart=' deploy/orbis-server/orbis-server.service` → `%h/.local/share/mise/installs/bun/1.4.1/bin/bun src/index.ts`. `git diff --check` → exit 0.

### Step 2: Make the deployment recipe explicit and fail early

In the existing “Install or update” section, add an owner-run runtime preflight before installing packages or restarting. Use a shell variable for the exact mise-managed executable from the unit, test that it is executable, and compare `"$BUN" --version` against 1.4.1. Fail with a clear message if missing; do not add a remote auto-installer. Use that same executable for the frozen install and contracts build so the shell PATH cannot choose another Bun.

Replace `enable --now` in the unified recipe with `systemctl --user enable orbis-server`, followed by `systemctl --user restart orbis-server`. `restart` starts an inactive unit too, so this handles both installation and updates. Keep `daemon-reload` after copying the unit. Follow restart with `systemctl --user is-active --quiet orbis-server` and status output.

Document that `daemon-reload` reloads unit definitions, not application code. Include an optional owner-run before/after `systemctl --user show orbis-server -p InvocationID --value` check: the invocation ID must change on an update. Do not use only a PID, which can be reused. Existing remote `/health` checks can validate reachability; do not expand their credential handling.

**Verify:** `sed -n '/^## Install or update/,/^## Enrol a device/p' deploy/orbis-server/README.md | grep -n 'daemon-reload\|enable\|restart\|is-active\|InvocationID'` → the update sequence includes all five concepts. `git diff --check` → exit 0.

### Step 3: Add safe failure and rollback instructions

State that this recipe runs on Vanta only after the owner approves the host and update window. Keep stored data and trust records outside the checkout untouched. If runtime preflight or dependency/build checks fail, stop before restart. If the new process fails, use the last known-good checkout/runtime and restart under owner control; never delete data or print environment secrets. Preserve existing notes about external port conflicts and unrelated Funnel services.

For an owner-approved live validation, record only old/new invocation IDs, active status, Bun version, and expected HTTP status codes. In a plan-only or repository-only execution, record “live rollout not performed” instead of claiming success.

**Verify:** `git diff --check && git diff --stat` → exit 0 and only the two scoped files plus the index changed relative to the executor's start state.

## Test plan

This is a documentation/unit fix; do not invent an application test for systemd. On an owner-approved Vanta update, runtime preflight must pass, `systemctl --user is-active --quiet orbis-server` must exit 0, and `InvocationID` must differ before and after the update. The known local/remote health statuses must remain unchanged. These commands were not executed during the audit.

## Done criteria

- [ ] Unit and deployment recipe use the manifest/CI Bun version.
- [ ] The update recipe explicitly restarts after reload and verifies active status.
- [ ] Runtime failure stops before restart; no secret-reading or data-deletion commands were added.
- [ ] `git diff --check` exits 0 and the executor-created diff stays within Scope.
- [ ] Index row updated, with live validation clearly distinguished from repository completion.

## STOP conditions

Stop for unexplained deployment changes, divergent runtime pins, missing runtime on the target host, a request to change another service, or failure of a verification gate twice. Do not install Bun or touch Vanta merely to complete this plan. If plan 001 changed listener wiring, preserve it; if its rollout status is unknown, do not imply the authentication boundary is live-fixed.

## Maintenance notes

Future Bun upgrades must update the manifest, CI, service executable path, and this preflight together. A reviewer should check that install and start use the same executable. Build/version diagnostics in `/health` remain a separate, unselected product direction.
