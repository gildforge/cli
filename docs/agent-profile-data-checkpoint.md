# Profile/control/support/snapshot data consumers — CLI #70

Consumes only the changed generated contract from signed website
9142ecd8858dca7d5a37f909869a05ad513f0c1b. Exact source/header parity and output
SHA256 e71692d72e6305ba2344f1a3e64a49327ced6b1ffad539423cedbadd1917160f
verified against that commit. Receipt: agent-profile-transfer-9142ecd.json.
Canonical helper, additive scopes, client and generator retain their prior exact
bytes; legacy scopes retain ca5d606. No full generator or website source edits.

Thirteen actual consumer tests cover strict profile/control/support schemas,
own precondition descriptors and missing428/malformed422/stale412, replacement
and rollback stale precedence over negative-number/lone-surrogate body fields,
matching invalid-body422, creation-null, unsupported version, forbidden
credentials/machine fields/authority, exact DNS constraints and evidence references.
Snapshot tests bind owner/agent generations, revision/profile digest, exact runtime,
complete ordered immutable skill/manifest selection and support-report identity/hash.
Discovery cannot replace declared verified delivery in the requested mode;
required controls reject advisory/unsupported status or unverified boundaries.
The 806-byte profile fixture is copied from the exact canonical commit, including
its no-newline bytes, SHA256
5d305adee182d62eed11d5a68ba41892739ce29c65e7647f49ffa2b62b95e024.
The existing 1069-byte ECC canonical bundle vector remains unchanged.

`node scripts/profile-data-revert.mjs` performs nine meaningful removals on owned
.tmp copies, never modifying tracked generated outputs: missing/stale guards,
wrong canonical-before-stale ordering, owner generation, profile digest, support
digest, full skill binding, delivery declaration, required-control guard. Each
fails with actual Bun assertion diagnostics; temporary source restores and tracked
output remains byte-exact. Ledger .tmp/profile-data-revert-evidence.json.

Restored combined profile/native/cache/materialization/consumer/client/scope/event/
Actions regressions:118pass/0fail/628assertions across12files,5.65s. New profile
suite13pass/164assertions. Typecheck, full src/scripts format check and diff check
pass. Logs .tmp/profile-data-{final-positive,typecheck,format,removals}.log;
parity receipt .tmp/profile-data-parity.json. Existing hosted PR workflow is
unchanged; no local full pack, installed matrix, provider call or shared daemon.

This checkpoint validates declarative data only. Synthetic reports labeled
verified/enforced are not authentic runtime evidence. Live identities, ownership,
model/adapter support, project/tool authority and report/evidence authentication
remain backend/harness duties. No profile CRUD/history/audit/idempotency routes,
task/claim/continuation/audience API, scope issuance, launch permit, execution
claim, TUI/piped/resume delivery or admission wiring is introduced. Independent
exact-SHA canonical correction review cleared precedence at9142ecd; new exact-head
CLI consumer source review/hosted CI remain pending.
The earlier a0e4b5d materialization/6ce432f shutdown acceptances are historical
proof for those slices, not acceptance of this new head.

Actions behavior remains the released0.6.9 contract: upload-artifact and cache
fail because this runner has no corresponding backend; enabled setup-node/go
cache inputs fail with a remove-cache diagnostic. Omitted/empty/false/'false'
inputs continue without caching; continue-on-error retains failed-step semantics.
Real executeJob regression is included in the combined run. No successful no-op.

PR71 remains draft held; package0.6.9 unchanged. No merge/release/deployment,
credential/scope/provider permissions or real enforcement certification.

-codex
