## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect source repository is available at `~/.local/share/effect-solutions/effect` for reference.
Use it to explore APIs, find usage examples, and understand implementation details when the documentation is not enough.

## Agent skills

### Issue tracker

Use GitHub Issues in ParthMmm/orbis. Before reading or publishing specs and tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before applying triage labels, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root glossary and ADR directory. Before exploring domain behavior, read `docs/agents/domain.md`.

## Verifying the Mac UI

Verify quietly. Read state, and leave the operator's display alone: they work on this machine while you run on it, so a check that raises a window or moves the pointer costs them the screen, and the same answer usually sat in a test result, a log line, or their description of what they see. Spend the screen when the pixels are the answer, and ask first.

Three tools, quietest first:

- **agent-device** reads a macOS or iOS app through accessibility. Its snapshot answers most questions.
- **agent-browser** drives web pages through the executor MCP. Run it headless.
- **Codex computer use** acts on the visible screen. Four integrations carry it and only `codex-computer-use` holds the full set, including `set_value` and `scroll`; reach it with `tools.search` from the executor's `execute` tool.

A session or a server outlives the turn that started it and clutters a machine the operator is using, so close the session and stop every process you started.
