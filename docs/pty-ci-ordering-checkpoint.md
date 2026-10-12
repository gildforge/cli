# Intel installed PTY follow-up — CLI #70 / PR71

At signed head 48d92eb, bounded source review cleared the physical bundle/cache
slice. Hosted run 38188632339 passed Linux, Apple Silicon and vz-helper, but Intel
failed the installed PTY suite (101 pass, 4 skipped, 2 failed, 589 assertions). Completed
job 114616342117 logs are retained at `.tmp/pr71-intel-pty-job.log`; ANSI was
stripped only for inspection. These failures did not clear full CI.

The nudge harness asserted cumulative idle firing>2 immediately after its final
Stop/status request. The failed snapshot already had a rearmed non-null nextDue;
it did not await the next firing. The harness now uses its existing bounded wait
for both firing>2 and actual third idle-prompt delivery before checking CLI status.
The original count assertion, repeat-limit semantics, channel/events checks and
80s/90s outer bounds remain unchanged. There is no product watchdog-rule change
or blind time-budget increase.

The stop harness observed final exit/EOF while `leaving.sock` still existed.
Worker source sent the final event and awaited flushing before `restore()`
removed the listener/files, allowing a caller to observe completion too early.
`finalizeSessionStreams` now awaits retirement before sending final exit/EOF;
existing connected stop/subscriber/viewer peers stay open for ordered delivery.
Worker retirement runs once, clears ownership and preserves VM final sync before
the final result. Drain limit 500ms, final event shape and signal codes are unchanged.

A real Unix-socket regression holds cleanup behind a barrier. No final end is
observable while files exist; every received final-event chunk observes removed
files. It handles arbitrary stream fragmentation. Moving cleanup after final
delivery fails at an actual assertion (`node scripts/pty-exit-revert.mjs`), with
source restored and positives rerun. The installed-PTY gate now includes this
test. Existing VM lifecycle fixtures also assert session files are gone when the
final result arrives, while retained recovery metadata still exists.

First local source attempts failed before either intended scenario because this
worktree's temporary HOME exceeded the existing Unix socket path bound. Preserve
`.tmp/pty-stop-focused.log` and `.tmp/pty-nudge-focused.log` as **setup failures**.
The two Python harnesses and VM lifecycle fixture now accept test-only
`TEST_GILD_FIXTURE_TMP`; default paths and production socket limits are unchanged.
Owned short root `/Volumes/Projects/codex/.tmp/g70-pmamxx7x` was used. Homes are
private per-test directories removed by their fixtures. No global HOME/config,
installed CLI or provider credentials were changed.

Lightweight source evidence:

- Real nudge and detached-stop source reproductions: 2 pass, 21.33s,
  `.tmp/pty-source-short-root.log`.
- All detached scenarios plus watchdog/cleanup tests: 17 pass, 12.78s,
  `.tmp/pty-final-focused.log`.
- Final fragmentation-safe cleanup/watchdog unit rerun: 11 pass, 66 assertions,
  `.tmp/pty-order-unit.log`; cleanup-after-exit removal proof passes.
- Four VM final-result fixture cases: 4 pass, 59 assertions, 2s,
  `.tmp/pty-vm-lifecycle-focused.log`. These use fake VM children, not real VM or
  model readiness, and cover success/partial/failure plus recovery delivery.
- Typecheck, format and diff checks pass. No local full pack/installed suite.

Reproduce the two source failures' corrected behavior with
`TEST_GILD_FIXTURE_TMP=<owned-short-root> bun test src/spawn-nudge-pty.test.ts src/spawn-detach.test.ts --test-name-pattern 'watchdog nudges|detached session: stop' --timeout 30000`.
The original test-specific bounds still apply. Use the same variable for the
four `VM worker final result` cases.

New exact-head source review and all-platform hosted installed CI remain pending.
PR71 stays draft under the existing hold; package 0.6.9, release workflow and
permissions remain unchanged. No additional CI watcher, local heavy slot,
credential/scope/provider operation, merge, release or deployment. The website
owns local heavy-test allocation. Broader policy/runtime integration still awaits
canonical artifacts; no full-feature certification follows from these checks.

-codex
