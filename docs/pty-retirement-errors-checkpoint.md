# Retirement rejection correction — CLI #70 / PR71

Independent P2 review withdrew the provisional cleanup clearance at `b887c3a`.
Observed all-platform green CI remains a fact; prior manifest/inventory/cache
clearance is unchanged. A directory-removal exception could skip listener/socket
retirement, reject finalization before exit delivery, and bypass process exit
while the ordinary failure handler ignored an already-closing session. The
supersession is recorded in #70 comment6116089044 and the PR/handoff.

Retirement remains one-shot, but every resource action is attempted in `finally`
even when file removal or listener closure fails. The first error is preserved.
Finalization catches cleanup rejection and emits the existing final-event shape
with nonzero code1; the worker reports the cleanup error locally. Existing
connected stop/subscriber/viewer peers still complete. Failed-to-remove private
files remain for owner cleanup; no successful deletion is claimed for them.

The worker disarms adapter cleanup before invoking it, handles its rejection,
and runs remaining restoration in `finally`. After final VM sync/reporting settles,
it arms the500ms drain +250ms exit allowance **before** retirement and terminal
flush. A cleanup rejection or blocked flush cannot skip process exit. Successful
final ordering, VM recovery-before-result, normal signal codes, drain500ms and
nudge firing/delivery assertions remain. No timeout was blindly increased.

Deterministic evidence uses real local Unix peers and the actual worker compiled
with owned fixture children. The host cleanup callback is injected to throw an
EACCES-shaped error; terminal flush deliberately never resolves. A connected stop
caller and subscriber receive final code1, the listener/socket retire, private
log files remain, cleanup is attempted once, a watcher gets EOF and the worker
exits1 within the bounded test. This is lifecycle/error-path evidence, not real
VM/model readiness or an OS-permission enforcement test.

An initial attempt to override a native fs export did not trigger the intended
error (final code0); it is retained at
`.tmp/retirement-worker-fs-injection-failed.log` and is not rejection evidence.
The corrected fixture targets the owned `DetachedHost.cleanup` callback and
records one invocation. Only the fake-child worker used by this test is altered;
production code and other test cases use their actual implementations.

Lightweight restored-source checks:21 pass,0 fail,148 assertions across five
focused source PTY/watchdog/cleanup/worker files,33.64s. This includes real third
idle-prompt delivery and detached scenarios plus five VM lifecycle fixture cases.
Separate worker checks:5pass/75assertions; real-peer unit checks:2pass/13assertions.
Typecheck, format and diff checks pass. Logs `.tmp/retirement-final-positive.log`,
`retirement-worker-positive.log`, `retirement-unit-positive.log`,
`retirement-typecheck.log`, `retirement-format.log` and `retirement-removals.log`.

`TEST_GILD_FIXTURE_TMP=<owned-short-root> node scripts/pty-exit-revert.mjs`
proves four actual assertion failures: cleanup after final delivery, omitted
rejection handling, skipped remaining retirement, and disabled bounded-exit
fallback. Sources restore after each case and positives pass afterward. Without
the exit fallback the blocked-flush worker reaches the test deadline; its owned
PID is then force-killed by fixture teardown. Ledger:
`.tmp/pty-exit-revert-evidence.json`. Existing short root and test-specific/overall
bounds are unchanged. No local full pack/installed suite or completed-CI rerun.

Corrected exact-head source review and hosted CI remain required. PR71 stays draft
held, package0.6.9/release unchanged, website local heavy-test slot preserved.
No credential/scope/provider/global-install/merge/release/deployment authority.
Broader canonical policy/routes/run materialization/delivery/enforcement and
actual VM/model acceptance remain pending.

-codex
