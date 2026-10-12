# Private local materialization — CLI #70

This independent slice follows cleared `6ce432f` and uses the delivered canonical
`665af2a` manifest/selection/digest helpers and verified physical bundle cache.
It treats selections as data, never execution authority. There is no production
TUI/piped/resume launch wiring, task/claim/journal schema, policy/result endpoint,
private-context delivery, harness registration or instruction execution.

`materializeSkillBundle(cache, selection, manifest, ownedRunDirectory)` creates
one exclusive local `selected-skill/{manifest.json,files/<declared paths>}`.
This layout is a private CLI implementation choice, not a shared VM/container
protocol. Inputs and every copied byte are checked before any destination write.
Destinations must be normalized, no-follow, private and owned. Filesystem identity
checks reject the cache or its descendants as destinations; no path-prefix trust.
Run-directory names are bounded to4096 and use the local portable-path subset.
Existing selected directories/files/symlinks and case/normalized aliases fail.

Cache and materialization use one shared tree verifier/writer. Exact canonical
manifest bytes and complete file/directory inventories are checked, preserving
the original license and all declared assets. Copies use fresh regular-file
inodes, not hard links or shared writable selected roots. Selected files and
manifest are0400; directories remain private0700 so owners can clean up. These
mode flags do not establish same-user OS isolation or runtime tool enforcement.
Changes to one copy do not propagate to other copies or the cache.

A private exclusive stage is reverified before atomic no-replace publication;
the selected tree is verified again before a handle is returned. A competing
complete destination is refused rather than shared/adopted, even at the same pin.
Unpublished stages remain private and unselected. Pre-publication preparation
may be explicitly retried; completed/uncertain selected destinations are never
automatically adopted. This is conservative local disk behavior, not a server
launch journal or execution-claim/replay policy.

The returned frozen handle exposes `read` and idempotent `close`, with no absolute
pathname or raw descriptor offered as a trusted launch location. Reads revalidate
the held directory and return copied byte buffers, copied manifest and selection;
caller mutation cannot alter the internal binding. Run-path replacement cannot
redirect descriptor-relative writes or reads. Closed handles refuse reads.
Owner tampering/corrupt bytes/extra entries/hard links/symlinks fail revalidation.
Repeated checks are not an adversarial filesystem snapshot or power-loss proof.

Lightweight Intel checks: **103pass/0fail/444assertions** across10
materialization/cache/native/consumer/client/event files,4.36s. Fifteen new
materialization cases include exact license/nested assets, independent inodes,
cache separation, stale/corrupt/missing/unexpected data, aliases, root replacement,
closed-handle lifetime, staged corruption, pre/post-publication owned-child
interruption and competing publishers. All canonical artifact hashes are unchanged.
Typecheck, format and diff checks pass.

`node scripts/materialize-revert.mjs` proves five actual assertion failures for
omitted cache separation, copied-byte preflight, file0400 setup, staged recheck
and collision refusal. Source restores after every proof; positive checks pass.
The six cache and four consumer removals also pass after the shared-helper
refactor; the manifest-lock proof now targets the shared verifier. Ledgers/logs:
`.tmp/materialize-*`, `materialize-revert-evidence.json`. Existing macOS native
gates now include this suite; Linux already runs all tests. No local full pack,
installed suite, provider/model call, global install or shared-daemon mutation.
An additional Codex metadata probe was unnecessary; native instruction delivery
remains unverified and independent of prepared files.

Next dependency is the remaining canonical profile/control/support/task/claim/
continuation/audience schemas/routes and authority-bound runtime snapshot rules.
These must define legitimate run/identity binding, launch/resume admission,
delivery and enforcement before this local layer is wired into a real harness.
No missing field was invented to authorize this byte/materialization portion.
Prior shutdown clearance keeps its limits:500ms peer drain best effort;750ms
asynchronous fallback starts after VM/reporting settle and is not a total or
synchronous-I/O deadline; failed removal needs owner cleanup.

New exact-head source review/hosted CI are pending. PR71 stays draft held,
package0.6.9/release unchanged, website local heavy slot retained. No new
credentials/scopes/provider/merge/release/deployment authority or full-feature,
real VM/model/runtime certification.

-codex
