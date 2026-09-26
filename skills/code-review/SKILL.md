---
name: code-review
description: "Review everything changed since a base point (commit, branch, tag, or merge-base) on two separate axes: Standards (does it follow the repo's documented conventions?) and Spec (does it do what the issue or spec asked?). Runs the two reviews in parallel sub-agents and reports them side by side. Use when the user wants a branch, PR, or work in progress reviewed, or asks to \"review since X\"."
---

# Code Review

Review the diff between `HEAD` and a base point on two axes, kept apart on purpose:

- **Standards:** does the change follow how this repo says code should be written?
- **Spec:** does the change do what the originating issue or spec asked, no more and no less?

A change can pass one and fail the other. Clean code that builds the wrong thing passes Standards and fails Spec. The right feature written against the repo's conventions passes Spec and fails Standards. Each axis runs in its own sub-agent, so neither context colours the other, and the results are reported separately, so one axis cannot hide the other.

For GitHub lookups, use `gh`: `gh issue view <n> --comments`, `gh pr view <n> --comments`. Issues and PRs share numbers, so try `gh pr view` first and fall back to `gh issue view`.

## 1. Base point and diff

The base point is whatever the user named: a SHA, branch, tag, `main`, `HEAD~3`. If they named none, ask.

Check it resolves with `git rev-parse <base>`. Record:

- the diff command: `git diff <base>...HEAD` (three dots, so it compares against the merge-base)
- the commits: `git log <base>..HEAD --oneline`

If the ref does not resolve or the diff is empty, stop and say so now, before starting any sub-agent.

## 2. Find the spec

Try, in order:

1. Issue or PR references in the commit messages (`#12`, `Fixes #34`, `Closes #56`), fetched with `gh`.
2. A spec path the user gave.
3. A spec file under `docs/`, `specs/`, or `.scratch/` whose name matches the branch or feature.
4. Ask the user. If they say there is no spec, the Spec review is skipped and the report says "no spec available".

## 3. Find the standards

Collect every file in the repo that says how code should be written, for example `CONTRIBUTING.md`, `CODING_STANDARDS.md`, a style guide, or an ADR folder.

The Standards review also always checks the **smell list** below (the classic code smells from Fowler's *Refactoring*), even when the repo documents nothing. Two rules apply:

- **The repo wins.** If a documented repo standard allows something a smell would flag, drop that smell.
- **Smells are opinions.** Report each as "possible <smell>", never as a hard violation. Skip anything a linter or formatter already enforces.

Smell list, as *sign* → *usual fix*:

- **Mysterious Name:** a name that does not say what the thing does or holds. → Rename. If no honest name exists, the design is unclear.
- **Duplicated Code:** the same logic appears in two or more places in the change. → Extract it once and call it from each place.
- **Feature Envy:** a function works mostly with another object's data. → Move it to that object.
- **Data Clumps:** the same group of values keeps being passed together. → Make them one type.
- **Primitive Obsession:** a raw string or number stands in for a domain concept. → Give the concept a small type.
- **Repeated Switches:** the same branch on the same kind of value appears in several places. → One lookup table or polymorphism, shared.
- **Shotgun Surgery:** one logical change needs edits scattered over many files. → Put what changes together in one module.
- **Divergent Change:** one module is edited for several unrelated reasons. → Split it by reason to change.
- **Speculative Generality:** parameters, hooks, or abstractions the spec does not need. → Remove them until a real need appears.
- **Message Chains:** callers walk `a.b().c().d()` to reach something. → Give the first object one method that does the walk.
- **Middle Man:** a class or function that only forwards calls. → Remove it and call the target directly.
- **Refused Bequest:** a subclass or implementer that ignores or overrides most of what it inherits. → Replace inheritance with composition.

## 4. Run both reviews in parallel

Use the harness's own sub-agent mechanism. Each sub-agent sees only what its prompt gives it, so include everything it needs. If the harness has no sub-agents, run the two reviews one after the other, each working only from its own prompt, and keep their findings apart.

**Standards prompt** includes:

- the diff command and the commit list
- the standards files from step 3 and the full smell list with its two rules, pasted in
- the task: "For each file or hunk, report (a) every breach of a documented standard, citing the file and rule, and (b) every smell from the list you see, naming it and quoting the hunk. Mark documented-standard breaches as hard or judgement call; smells are always judgement calls, and a documented standard overrides a smell. Ignore anything tooling enforces. Stay under 400 words."

**Spec prompt** includes:

- the diff command and the commit list
- the spec's path or its fetched text
- the task: "Report (a) requirements that are missing or only partly done, (b) behavior in the diff the spec did not ask for, and (c) requirements that seem implemented but look wrong. Quote the spec line behind each finding. Stay under 400 words."

With no spec, skip the Spec prompt and say so in the report.

## 5. Report

Show the two results under `## Standards` and `## Spec`, as returned or lightly tidied. Do not merge, reorder, or re-rank findings across the axes.

Finish with one line: the number of findings on each axis and the worst finding on each axis, if any. Do not name one overall worst finding; comparing across axes is what the split avoids.
