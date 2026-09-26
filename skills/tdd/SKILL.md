---
name: tdd
description: Test-driven development. Use when the user wants to build a feature or fix a bug test-first, mentions "red-green-refactor", or asks for integration tests.
---

# Test-Driven Development

Work in a red → green loop: one failing test, then the least code that makes it pass, then the next test. This skill says what makes those tests worth keeping. Apply all of it on every cycle, not as a check at the end.

Before naming anything, read the repo's domain docs if it has them (`CONTEXT.md`, glossaries, ADRs) so tests and interfaces use the project's own terms and respect its recorded decisions.

## Seams

A **seam** is a public boundary where you can observe behavior without looking inside: an exported function, a CLI command, an HTTP endpoint, a component's props and rendered output. Every test sits on a seam, never on internals.

**Agree the seams before writing any test.** List the seams you intend to test and get the user's confirmation. Do not write a test on a seam the user has not confirmed. Testing everything is impossible; agreeing seams first puts the effort on critical paths and tricky logic rather than on every edge case.

Ask: "What is the public interface here, and which seams should we test?"

If the right shape of the interface is itself unclear (what it should expose, how much it should hide, where the boundary belongs), settle that with the user before picking seams.

## A good test

- Exercises behavior a caller cares about, through the public interface only.
- Keeps passing when internals are rewritten, as long as behavior is the same.
- Has a name that states a capability ("rejects an expired coupon"), not a mechanism ("calls validateDate").
- Checks one logical outcome.
- Takes its expected value from an independent source: a literal worked out by hand, an example in the spec, a known-good output.

```python
# Good: behavior through the interface, expected value worked out by hand
def test_expired_coupon_is_rejected():
    cart = Cart(items=[Item(price=40)])
    result = cart.apply_coupon(Coupon("SPRING", expires=date(2020, 1, 1)))
    assert result.accepted is False
    assert cart.total() == 40
```

## Anti-patterns

- **Coupled to implementation.** Mocks the code's own collaborators, calls private helpers, asserts call counts or call order, or checks the result through a back door (reading the database row instead of fetching through the API). Symptom: a refactor that keeps behavior intact breaks the test.
- **Tautological.** The expected value is computed the same way the code computes it, so the test cannot fail. Example: asserting `total(items) == sum(i.price for i in items)`. Use a hand-computed literal instead: `total([Item(40), Item(15)]) == 55`.
- **Horizontal slicing.** Writing every test up front, then all the code. Those tests describe a guessed design, check shapes instead of behavior, and lock in structure before you have learned anything. Instead, slice vertically: one test, the code for it, then the next test, each one informed by what the last cycle showed.

## Mocking

Mock only where the system meets something you do not own: third-party APIs, email or payment services, the clock, randomness, and sometimes the filesystem or database (prefer a real test database when practical). Never mock your own modules or internal collaborators.

Make those outer edges easy to replace:

- **Inject the dependency.** Accept the client as a parameter instead of constructing it inside the function, so a test can pass a fake.
- **One function per external operation.** Prefer `api.fetch_invoice(id)` and `api.send_reminder(id)` over one generic `api.request(path, opts)`. Each fake then returns one fixed shape with no branching, and it is obvious which calls a test depends on.

## Loop rules

- **Red first.** Watch the new test fail before writing the code. Then write only what makes it pass: nothing for future tests, no speculative features.
- **One slice per cycle.** One seam, one test, one minimal implementation.
- **No refactoring inside the loop.** Cleanup happens in review (the `code-review` skill), after the red → green cycles are done.
