---
name: solve-issue
description: "Pick an open GitHub issue and set up a branch for it: checks gh auth, picks the repo, shortlists unclaimed issues, recommends one, then forks, clones, branches, writes an agent brief, implements it test-first with local commits, reviews and fixes it in up to 3 rounds, and after explicit approval pushes and opens a pull request. User-invoked only."
disable-model-invocation: true
---

# Solve Issue

Walk the user from "I want to fix something" to one chosen GitHub issue, implemented, reviewed, and opened as a pull request from its own feature branch. Use the `github` skill for `gh` conventions. Run each step in order; do not skip ahead.

## 1. Auth gate

Run `gh auth status`.

- **Logged in:** tell the user which account is active (the `Logged in to github.com account <login>` line) and continue.
- **Not logged in:** stop. Never run `gh auth login` yourself and never type, paste, or ask for a token or password. Tell the user to run this in their own terminal and say when it is done:

  ```bash
  gh auth login
  ```

  When they say it is done, run `gh auth status` again. Continue only once it reports a logged-in account; otherwise repeat this step.

## 2. Pick the repository

Ask the user which of these they want:

- **Own repo:** if the current directory is a git checkout with a GitHub remote, offer it (`gh repo view --json nameWithOwner --jq .nameWithOwner`). Otherwise, or if they want another one, list theirs with `gh repo list --limit 30 --json nameWithOwner,description,hasIssuesEnabled` and let them pick.
- **External repo:** they name an `owner/repo` they want to contribute to. Check it with `gh repo view <owner>/<repo> --json nameWithOwner,hasIssuesEnabled`.

If the repo does not exist or has issues disabled, say so and ask again.

## 3. Shortlist issues

Fetch candidates:

```bash
bash <this skill's directory>/scripts/candidates.sh <owner>/<repo>
```

It returns the 50 most recently updated open issues, minus any that are assigned, have an open PR that will close them, or are mentioned by an open PR in the same repo. Output is JSON: `number`, `title`, `url`, `labels`, `comments` (count), `maintainerLastCommentAt` (latest comment by an owner, member, or collaborator among the last 20; `null` if none), `updatedAt`, and the first 600 characters of `body`. If the list is empty, say so and offer to pick another repo.

Present up to 10, one line each: `#<number> <title> — <one-line summary of what needs doing>` plus notable labels. Write the summary from the body, not the title.

Then mark **exactly one** as the recommended pick and say why in one or two sentences. Weigh:

- **Scope:** small and contained beats sprawling or design-heavy (RFCs, "discussion" issues).
- **Clarity:** clear repro or acceptance criteria beats vague reports.
- **Labels:** `good first issue`, `help wanted`, `bug` with a repro count in favour; `needs-triage`, `blocked`, `wontfix`, `question` count against.
- **Activity:** a recent `maintainerLastCommentAt` and recent `updatedAt` beat stale threads.

## 4. Human gate 1: the user picks

Ask the user which issue to work on. **Stop here and wait.** Do not read the full issue, clone, fork, branch, or change anything until the user names an issue number from the shortlist (or another open issue in the same repo). Accepting your recommendation counts only if the user says so.

Once the user picks, confirm back `<owner>/<repo>#<number> <title>`. That is the input to the next step.

## 5. Workspace setup

Pick the working directory:

- If the current directory is a clone of `<owner>/<repo>` or of the user's fork of it (`git remote -v`), use its root.
- Otherwise ask whether they already have a local clone and where. If not, propose `<repo>` inside the current directory (next to it if the current directory is itself a git checkout).

Then run:

```bash
bash <this skill's directory>/scripts/workspace.sh <owner>/<repo> <number> <dir>
```

Before running it, check `gh repo view <owner>/<repo> --json viewerPermission --jq .viewerPermission`. Anything other than `ADMIN`, `MAINTAIN`, or `WRITE` means the script will fork: tell the user first that this creates a fork under their GitHub account. The script:

- Forks only without push access, reusing the user's existing fork even if it was renamed, so `origin` is the fork and `upstream` the original. With push access it uses the repo directly.
- Clones into `<dir>` only if it does not exist; otherwise reuses it and adds or renames remotes as needed, in the same URL style (https or SSH) as the existing ones.
- Refuses a working tree with uncommitted changes, and a local default branch that has diverged from upstream.
- Fast-forwards the default branch from upstream, then switches to `fix/<number>-<slug>` (`feat/` or `docs/` when the labels say so), reusing that branch as-is if it already exists (it is not rebased; mention this to the user).

It prints JSON: `dir`, `mode` (`fork` or `direct`), `fork`, `pushRemote`, `syncRemote`, `defaultBranch`, `branch`, `branchExisted`, `cloned`, and `guidelines` (paths of `CONTRIBUTING*`, PR templates, and `AGENTS.md` found in the repo). If it fails, show the user the error and stop. Never stash, reset, or discard their changes yourself.

Capture the repo's conventions for later steps in a scratch directory **outside** the repo, `${XDG_STATE_HOME:-$HOME/.local/state}/solve-issue/<owner>-<repo>-<number>/`:

- `workspace.json`: the script output.
- `guidelines.md`: from the `guidelines` files, `git log --oneline -20`, and the CI workflows and build files (`package.json` scripts, `Makefile`, etc.): commit message style, sign-off or CLA requirements, the lint/typecheck/test commands, and the PR template path with its required sections. Write "none found" for anything missing.

Tell the user the directory, the branch, and whether a fork was used. Nothing is committed or pushed in this step.

## 6. Agent brief

Read the whole issue, not just the shortlist excerpt:

```bash
gh issue view <number> --repo <owner>/<repo> --json number,title,body,labels,comments,url
```

Comments often narrow or change the ask; a maintainer's comment outranks the original body. Then explore the code the issue touches in `<dir>` until you can name the real interfaces involved.

Write the brief with the `agent-brief` skill's template (category, summary, current vs desired behavior, key interfaces, acceptance criteria, out of scope) to `brief.md` in the scratch directory from step 5. Never write it inside the repo and never post it to the issue. Every acceptance criterion must be concrete and independently checkable; include "covered by a test" where the repo has a test setup. If the issue is too vague to write testable criteria, tell the user what is unclear and ask before continuing.

Show the user the summary and acceptance criteria, and the seams you plan to test at (the `tdd` skill requires agreeing them). Continue once they agree or adjust.

## 7. Implement

Follow the `implement` skill with `brief.md` as the spec, in `<dir>` on the feature branch:

- Test-first with the `tdd` skill at the agreed seams, one red → green slice at a time, using the repo's own test framework and layout. If the repo has no test setup, say so and do not add one.
- Run the typecheck and the single test file you are working on regularly; run the full lint/typecheck/test commands from `guidelines.md` once at the end. If any fail, fix them when caused by your change; otherwise report the exact failing command and its shortest decisive error line to the user. Never claim a check passed that you did not run.
- Commit on the feature branch only, in the commit style from `guidelines.md` (including sign-off if required), and reference the issue in every commit (e.g. `(#<number>)` in the subject, or `Refs #<number>` in the body). Do not push.
- Before each commit, run `git status` and stage files by name. Never commit the brief, notes, `workspace.json`, `guidelines.md`, or agent config (`CLAUDE.md`, `AGENTS.md`, `.claude/`, and similar) unless the issue itself is about them.

Tell the user the commits made (`git log --oneline <defaultBranch>..HEAD`) and the result of each check command.

## 8. Review and fix loop

Review the feature branch with the `code-review` skill, at most 3 rounds:

- **Fixed point:** `<syncRemote>/<defaultBranch>` from `workspace.json` (run `git fetch <syncRemote>` first), so the diff is `git diff <syncRemote>/<defaultBranch>...HEAD`.
- **Spec source:** `brief.md` from the scratch directory, plus the issue fetched in step 6. Pass both to the Spec sub-agent; do not let it go looking for another spec.
- **Standards sources:** the files in `guidelines` from `workspace.json` and any other coding-standards docs in the repo, plus the smell baseline.

Run the Standards and Spec sub-agents in parallel, as `code-review` says. Then, for each finding:

- **Accept** it if it is a real defect, a missing acceptance criterion, or a breach of a documented repo standard. Fix it on the feature branch.
- **Reject** it if it is wrong, out of the brief's scope, or a judgement-call smell you disagree with. Write down one line on why.

After the fixes, run the full lint/typecheck/test commands from `guidelines.md` again. Fix failures your change caused; report others as in step 7. Commit the fixes as in step 7 (same style, issue reference, staged by name, no push).

Start the next round if you fixed anything. Stop when both axes come back with no findings you accept, or after round 3, whichever is first.

Write `review.md` in the scratch directory, for the next step:

- Rounds run and why the loop stopped (clean, or round limit).
- Per axis (`## Standards`, `## Spec`): each finding, and whether it was fixed (with the commit) or remains, and why.
- The final result of each check command.

Show the user this summary. Never claim a round was clean or a check passed if you did not run it.

## 9. Human gate 2: push and open the pull request

Nothing has left the machine yet. Show the user, in one message:

- The diff summary: `git log --oneline <syncRemote>/<defaultBranch>..HEAD` and `git diff --stat <syncRemote>/<defaultBranch>...HEAD`.
- The final result of each check command, from `review.md`.
- The review summary from `review.md`, including findings that remain.
- Where it will go: the branch pushed to `<pushRemote>` (the fork `<fork>` in fork mode), and a PR against `<owner>/<repo>` `<defaultBranch>`.

Ask whether to push and open the PR. **Stop here and wait.** Only an explicit yes in this session counts; silence, a question, or an earlier approval does not. If the user declines, stop: push nothing, and leave the local branch and its commits as they are. Tell them the branch name and directory so they can pick it up later.

On approval, write the PR body to `pr-body.md` in the scratch directory:

- If `guidelines.md` names a PR template, fill in its sections.
- Otherwise include: what changed and why, how it was tested (the check commands and their results), open review findings from `review.md` (or "none"), and nothing else.
- Always include `Closes #<number>` and a line saying the change was AI-assisted and reviewed by the submitter before opening. Keep both even when the template has no place for them.

Then push and open the PR:

```bash
git push -u <pushRemote> <branch>
gh pr create --repo <owner>/<repo> --base <defaultBranch> --head <head> --title "<title>" --body-file <scratch>/pr-body.md
```

`<head>` is `<fork owner>:<branch>` in fork mode (the owner part of `fork`), and `<branch>` in direct mode. Title the PR in the repo's commit style from `guidelines.md`. Never force-push. If the push or `gh pr create` fails, show the user the shortest decisive error line and stop; do not retry with other flags.

Show the user the PR URL that `gh pr create` prints. Then stop and hand off for human review. Never merge, approve, enable auto-merge, or request reviewers on the user's behalf.
