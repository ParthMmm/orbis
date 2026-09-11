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

Never drive the Mac's interface with screen automation. Do not use `agent-device`, `osascript` UI scripting, `cliclick`, or anything else that reads or clicks another application's windows. It takes over the machine, and the operator has asked for it to stop.

Use Codex computer use instead, reached through the executor MCP. Call the `executor_execute` tool with TypeScript, and leave the `acceptance` field alone:

```ts
const apps = await tools["codex-computer-use.org.default.list_apps"]({});
const state = await tools["codex-computer-use.org.default.get_app_state"]({
  app: "app.orbis.client",
});
```

Act through the same namespace. `get_app_state` and `list_apps` report, and `click`, `set_value`, `type_text`, `press_key`, `scroll`, `drag`, `paste`, and `perform_secondary_action` act. `click` takes either an `element_index` from the state or an `x` and `y`.

Ask the operator what the screen shows before reaching for any of this, and use it only when a claim genuinely needs the pixels. A test result, a log line, or the operator's own description is cheaper and does not take the machine away from them.
