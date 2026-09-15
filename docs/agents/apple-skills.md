# Project-local Apple skills

Skills-only installation, 2026-09-11. Canonical copies live in `.agents/skills/` for Pi/Codex shared project discovery; four selective relative symlinks in `.claude/skills/` expose the same copies to Claude. `git check-ignore` confirms both locations are ignored, so this note is the durable record.

Trees are byte-identical to the validated Mana-Margherita installation, not re-fetched from upstream here.

## Sources and licenses

| Skill | Source repository | Pinned commit | Upstream directory |
| --- | --- | --- | --- |
| `swiftui-expert-skill` | [AvdLee/SwiftUI-Agent-Skill](https://github.com/AvdLee/SwiftUI-Agent-Skill) | `4c6a97d15aa5e023538c3cb06b5192f241dd451d` | `skills/swiftui-expert-skill` |
| `swift-concurrency` | [AvdLee/Swift-Concurrency-Agent-Skill](https://github.com/AvdLee/Swift-Concurrency-Agent-Skill) | `45fa49e4e0b2af4d43b1cb458903f8030ac993bd` | `skills/swift-concurrency` |
| `swift-testing-expert` | [AvdLee/Swift-Testing-Agent-Skill](https://github.com/AvdLee/Swift-Testing-Agent-Skill) | `798e9b1a2bcac164d4f0c781908199e754f0bab6` | `swift-testing-expert` |
| `xcodebuildmcp-cli` | [getsentry/XcodeBuildMCP](https://github.com/getsentry/XcodeBuildMCP) | `e6ef59b49b44012c824f0a0de261c96142e37390` | `skills/xcodebuildmcp-cli` |

All four use MIT. Each local skill keeps its repository's unchanged root `LICENSE`: copyright 2026 Antoine van der Lee for the three AvdLee skills, copyright 2025 Cameron Cooke for XcodeBuildMCP.

## Topic ownership

These skills supplement existing guidance. They do not replace it.

- `write-swift` keeps local Swift conventions and already covers concurrency breadth and modern syntax. `swift-concurrency` adds depth for actor isolation, cancellation, and `Sendable` only when a task needs it.
- Axiom stays the platform fallback and is unchanged, including the `.pi` package entry and its selective Claude links.
- `OrbisDesign` owns tokens, components, glass usage, and failure vocabulary. SwiftUI guidance must not override those local decisions.
- `bun run native:lanes` remains the verification owner. It already provisions a temporary service, pairs a device, runs unit and journey tests, and exports screenshots.

## Verification skill

`.agents/skills/verify-orbis/` drives and proves the Apple client by hand, with `.claude/skills/verify-orbis` symlinked to it. The canonical copy is machine-local and ignored by git like the rest of `.agents/`, so this note is the durable record. Added 2026-09-14.

It is the complementary pass to `bun run native:lanes`, not a replacement, and its own body says so. What it adds is what a suite asserting labels it already believes cannot see: geometry, controls the journeys never tap, and states reached by hand. Its first run found the tag filter pill turning the filter off but not on, a `Clear search` that stalls on a loading state, and search results that cannot be opened.

- Entry point: `.agents/skills/verify-orbis/bin/orbis-verify`, with `doctor`, `build`, `launch`, `stop`, `scratch start|stop`, and `evidence`.
- Feature map: `.agents/skills/verify-orbis/features/` — one file per user-facing feature, indexed by its `README.md`.
- The traps that produce wrong conclusions live in the committed `docs/agents/ui-verification.md`.

## Execution boundary

**XcodeBuildMCP CLI `2.7.0` is installed on PATH** at `/Users/parthmangrola/.local/share/mise/installs/node/24.15.0/bin/xcodebuildmcp`, via `npm install -g xcodebuildmcp@latest`. The Homebrew channel was blocked by tap trust and was left alone; `brew trust` was not run. Reinstall through npm after a Node upgrade.

**No MCP connection was added.** Per this repository's Executor-only MCP policy, route any future Xcode MCP use through Executor rather than adding a direct server entry to a client config.

The 13 Python helpers in `swiftui-expert-skill` record and analyse `xctrace` profiles. They were reviewed statically and never executed. Recording can capture sensitive data and report output can overwrite an existing file, so use them only for an explicitly scoped profiling task.

macOS UI tests remain unverified on this host for the known reason recorded in `AGENTS.md`: the macOS UI test runner is killed before bootstrap. Adding a skill does not change that.

## Updating

1. Obtain approval for new pins, then fetch each repository into a temporary directory and verify the exact commit and skill path before copying.
2. Review changed instructions, executable helpers, and licenses without running helpers. Replace only the four named local skill directories and their license copies; keep Axiom, `write-swift`, `effect`, configs, and the selective symlink topology.
3. Parse the real YAML frontmatter (`name` and `description`), resolve local references and icon paths, and confirm byte identity against the approved source. Record new commits here after validation.
4. Restart or reload agent sessions so skill discovery picks up the change.

Installation checks parsed four frontmatters, resolved the Claude symlinks to the canonical directories, and compared every copied file byte-for-byte against the Mana installation. Upstream URLs, same-document anchors, runtime `${SKILL_DIR}` paths, and the prose placeholder `references/...` are intentional references, not missing local files. External website availability and live agent-session discovery were not tested.
