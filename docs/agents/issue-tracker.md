# Issue tracker: GitHub

Specs and tickets live in [ParthMmm/orbis](https://github.com/ParthMmm/orbis). Use the `gh` CLI.

- Create: `gh issue create --repo ParthMmm/orbis --title "..." --body-file <file>`
- Read: `gh issue view <number> --repo ParthMmm/orbis --json number,title,body,comments`
- List: `gh issue list --repo ParthMmm/orbis --state open --json number,title,labels,assignees`
- Comment: `gh issue comment <number> --repo ParthMmm/orbis --body-file <file>`
- Label: `gh issue edit <number> --repo ParthMmm/orbis --add-label <label>`; use `--remove-label` to remove.
- Close: `gh issue close <number> --repo ParthMmm/orbis`

Publish specs as issues. Refer to issues by linked title.

**PRs as a request surface: no.**

## Readiness and completion

Before marking a ticket ready, resolve every required repository path and ADR link on its target branch. If a required decision is still in a PR, record that PR as a blocker. ADRs state the intended design; issue acceptance checks record what is implemented and verified.

Keep implementation and live acceptance as separate checks on parent issues. Record each remaining external blocker and link the latest evidence. Close a parent only when all its acceptance checks pass, including live checks.

Link the [verification record](../development.md#retain-verification-evidence) from the resolution comment. Retain failed-run artifacts before retrying.

## Read issues when the CLI fails

Explicit JSON fields avoid the deprecated Projects query used by some `gh issue view` versions. If that read still fails, fetch the body and comments separately:

```sh
	gh api repos/ParthMmm/orbis/issues/<number>
	gh api --paginate repos/ParthMmm/orbis/issues/<number>/comments
```

## Wayfinding operations

Maps use `wayfinder:map`. Tickets are native GitHub sub-issues labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

- Link a child: `gh api --method POST repos/ParthMmm/orbis/issues/<map-number>/sub_issues -F sub_issue_id=<child-database-id>`.
- Add a blocker: `gh api --method POST repos/ParthMmm/orbis/issues/<child-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.
- Look up a database ID: `gh api repos/ParthMmm/orbis/issues/<number> --jq .id`. Database IDs are not issue numbers or node IDs.
- Find the frontier: query the map's sub-issues with `gh api --paginate repos/ParthMmm/orbis/issues/<map-number>/sub_issues`. Select open, unassigned children with no open blockers; inspect `issue_dependencies_summary.blocked_by` on each child. Take the first in map order.
- Claim before work: `gh issue edit <number> --repo ParthMmm/orbis --add-assignee @me`.
- Resolve: post a resolution comment, close the ticket, then add a linked summary to the map's Decisions so far.

Use native dependencies and sub-issues when available. If unavailable, use a child task list in the map, `Part of #<map>` in each child, and `Blocked by: #<number>` lines for dependencies. Resolve referenced blocker states when finding the frontier.
