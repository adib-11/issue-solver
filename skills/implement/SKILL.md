---
name: implement
description: "Build a change from a written spec, brief, or ticket list: test-first, checks run as you go, reviewed, and committed. User-invoked only."
disable-model-invocation: true
---

# Implement

Build what the spec, brief, or tickets the user points at ask for.

1. **Test-first.** Follow the `tdd` skill wherever the change has a testable seam, and agree the seams with the user before the first test.
2. **Check as you go.** Keep running the typecheck and the one test file you are working in. Run the whole test suite once, when the work is complete.
3. **Review.** When everything is built, review it with the `code-review` skill.
4. **Commit** the work on the branch you are on.
