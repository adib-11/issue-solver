---
name: github
description: "How to work with GitHub issues and pull requests through the gh CLI: view, list, comment, open a PR, including from a fork. Use when a skill needs to fetch an issue, list issues, post a comment, or open a pull request."
---

# GitHub via gh

Use the `gh` CLI for every GitHub operation. Inside a clone, `gh` picks the repo from `git remote -v`. Outside one, or to target a different repo, add `--repo <owner>/<repo>`.

| Task | Command |
|---|---|
| View an issue | `gh issue view <n> --comments` (structured: `--json number,title,body,labels,assignees,comments`) |
| List issues | `gh issue list --state open --json number,title,body,labels,assignees,comments --jq '[.[] \| {number, title, body, labels: [.labels[].name], assignees: [.assignees[].login], comments: [.comments[].body]}]'`; filter with `--label` or `--state` |
| Comment on an issue | `gh issue comment <n> --body "..."` |
| View a PR | `gh pr view <n> --comments`; the diff is `gh pr diff <n>` |
| Open a PR | `gh pr create --title "..." --body "..."`; add `Closes #<n>` to the body to link the issue |
| Open a PR from a fork | add `--repo <upstream-owner>/<repo> --head <fork-owner>:<branch>` |
| Comment on a PR | `gh pr comment <n> --body "..."` |

- For bodies longer than one line, pass them through a heredoc.
- Issues and PRs share numbers in a repo. When `#<n>` could be either, try `gh pr view <n>` first; if it fails, use `gh issue view <n>`.
