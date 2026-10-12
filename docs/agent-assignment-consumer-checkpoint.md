# Minimal assignment data consumer checkpoint

Only the generated contract from signed canonical
3840f4526a9cf6c133ea1e1cca04befb5645abaa is consumed. Source SHA256
1af2cd9c484971f976791b292e890a0b56db60571d328995c23fb1a3151b4a93;
standard-header output SHA256
33e444b18da75734fe7e12cea9f8f819288dad384a41fe2f3001453e835bce5f.
Transfer receipt: agent-profile-transfer-3840f45.json. Exact committed source,
generator and header were checked before copying the single output. Other three
outputs, encoder, legacy scopes and Actions support remain byte-identical.
Ava reports parent independent canonical source/data clearance. This new CLI
consumer code still requires its own source and exact-head hosted CI review.

The consumer suite calls BOTH verifyOwnerAssignmentPolicyProfile and
verifyAgentAssignmentArtifacts for the full profile → policy → request/task →
receipt chain. Interactive and piped positives bind immutable profile bytes,
policy/source/consent references, task instruction/audience/expiry and grant ID/
revision. Twenty relationship negatives isolate specific bindings with unrelated
task digests recomputed. Full-profile substitution negatives separately exercise
persona digest, identities, revision and selected projects. Strict request/receipt
and bounded policy cases reject context/environment/permit fields, invalid
instruction bytes, unbound modes, implicit audience and out-of-range allowance.
Missing own precondition is428, malformed/accessor422 without getter execution,
and stale412 before invalid body; closed coordination requires explicit null.
Receipts require literal false launchAuthority and executionAuthority.

Validation:

- `bun test src/api/agent-assignment-data.test.ts`:28pass/0fail/160assertions,
  final explicit exit0 restored run77ms; old v1 rejects contractVersion2, frozen
  raw806 profile bytes/digest and canonical1069 ECC manifest/digest unchanged.
- `node scripts/agent-assignment-data-revert.mjs`:14 actual Bun assertion failures
  on owned temporary copies: requester, project, mode, policy digest, consent,
  audience, grant ID/revision, task digest, profile digest/project coverage,
  bounded expiry and both false-authority fields. Tracked bytes unchanged and
  temporary subject restored. Ledger .tmp/assignment-consumer-revert-evidence.json;
  per-removal logs .tmp/revert-assignment-consumer-*.log; restored log
  .tmp/assignment-consumer-restored.log. No setup exception accepted as proof.
- `bun run typecheck`, `bun run format:check`, `git diff --check`:pass.

These pure consistency checks do not prove live consent, current owner/ancestor/
identity/project rights, actual count consumption or atomic assignment uniqueness,
persisted uncertainty fences, running supersession, grant effects, protected peer
proof or launch permission. Invented consistent fixture records/hashes grant no
rights. Separate website guarded D1/effect evidence and later real producers must
establish those properties. No local policy registry, grant producer, runtime
permit, broker/journal, HTTP/client method or launch/private-context wiring added.
Existing reviewed94 design is not runtime implementation acceptance.

No website files or workflows changed. Already-cleared suites/reviews/old-head CI
were not repeated; website keeps the local heavy slot. The unchanged PR workflow
will run the normal hosted platform/native/pack/installed gates; Ava owns the
single new-head CI watch. Package0.6.9 and draft hold remain. No merge, release,
deploy, boot/install, provider, credential, OS or security expansion.

-codex
