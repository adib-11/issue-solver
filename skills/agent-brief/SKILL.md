---
name: agent-brief
description: "Template and rules for an agent brief: the spec an unattended agent implements an issue or PR from. Use when writing a brief for an issue or PR before implementing it."
---

# Agent Brief

An agent brief is the contract an agent works from when it picks up an issue or PR without a human watching. The issue body and its comments are background; the brief is what counts. Where the brief and the thread disagree, the brief wins.

For an issue, the brief describes the change to build. For a PR, it describes what is still missing from the existing diff: gaps to close, review points to address. The rules are the same for both.

## Rules

### Write for a codebase that will move

A brief may wait days or weeks before an agent picks it up, and the code will change meanwhile. Write it so it stays true after renames and refactors.

- Name the types, function signatures, commands, and config shapes involved, and the contracts they must keep.
- Do not cite file paths or line numbers. They go stale.
- Do not assume the current internal structure will still exist.

### Say what, not how

Describe the behavior the system must have. The agent reads the code itself and chooses how to build it.

- Good: "`parse_duration()` accepts an `h` suffix and returns seconds."
- Bad: "In the parser file, add an `elif` branch after the `m` case."

### Make "done" testable

Each acceptance criterion is concrete and can be checked on its own.

- Good: "`parse_duration("2h")` returns `7200`."
- Bad: "Hour durations work properly."

### Draw the boundary

List what is out of scope, so the agent does not gold-plate or change neighbouring features.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one line on what has to change

**Current behavior:**
What happens today. For a bug, the broken behavior. For an enhancement, the starting point it builds on. For a PR, the state of the diff.

**Desired behavior:**
What happens once the work is done, including edge cases and error handling.

**Key interfaces:**
- `TypeOrFunction`: what changes and why
- Return types, config keys, CLI flags, or events that change, old vs new

**Acceptance criteria:**
- [ ] Concrete, independently checkable criterion
- [ ] ...

**Out of scope:**
- Related things this work must not touch
```

## Example: bug

```markdown
## Agent Brief

**Category:** bug
**Summary:** CSV export drops rows whose note field contains a newline

**Current behavior:**
Exporting orders to CSV writes a note containing a line break unquoted, so
spreadsheet tools split that order across two rows and shift every later column.

**Desired behavior:**
Any field containing a comma, double quote, or line break is wrapped in double
quotes, with inner double quotes doubled, as RFC 4180 describes. Other fields
are written unchanged.

**Key interfaces:**
- The order-export function that returns CSV text: signature unchanged, output
  quoting fixed
- The `Order.note` field: free text, may contain any character

**Acceptance criteria:**
- [ ] A note `line one\nline two` exports as one quoted field on one record
- [ ] A note containing `"` exports with the quote doubled
- [ ] Fields with none of the special characters are byte-for-byte unchanged
- [ ] A test covers each of the three cases above

**Out of scope:**
- Changing the column order or the header row
- Other export formats (JSON, XLSX)
```

## Example: enhancement

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** `backup` command gets a `--keep <n>` option to prune old snapshots

**Current behavior:**
Each `backup` run writes a new timestamped snapshot. Nothing deletes old ones,
so disk use grows without limit.

**Desired behavior:**
With `--keep <n>`, after a successful backup, only the newest `n` snapshots
remain. Without the flag, nothing is deleted. `n` must be a positive integer;
otherwise the command exits non-zero with a clear message before backing up.
If the backup fails, no snapshot is pruned.

**Key interfaces:**
- `backup` CLI: new `--keep <n>` option
- The snapshot listing already used by `backup list`: the source of which
  snapshots exist and their order

**Acceptance criteria:**
- [ ] `backup --keep 3` with 5 existing snapshots leaves the newest 3 after the run
- [ ] `backup` without `--keep` deletes nothing
- [ ] `--keep 0` and `--keep abc` exit non-zero and take no backup
- [ ] A failed backup with `--keep` deletes nothing

**Out of scope:**
- Time-based retention (`--keep-days`)
- Pruning remote copies
```

## What a bad brief looks like

```markdown
**Summary:** Fix export

The export is broken, check exporter.py around line 80.
```

It has no category, no current or desired behavior, no acceptance criteria, and no scope boundary, and it points at a file and a line number that will go stale.
