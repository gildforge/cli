# Skill byte/cache groundwork — CLI #70

This slice verifies declared instruction/asset bytes and stores verified byte
objects locally. It is independent of the agreed website wire contract: internal
`LocalSkillByteExpectation` is not a wire manifest, policy, bundle-cache layout or
run snapshot. Canonical generated validation/serialization, complete bundle
inventory, catalog/API integration, task claims and harness delivery are pending.

The candidate fixture is the unchanged ECC verification-loop skill at immutable
commit d4a44ded8c150aac89b37c1f665b5a749fe52b02, plus its original MIT notice. Both
file byte counts and SHA256 are checked before returning the candidate; provenance
is recorded in the fixture's PROVENANCE.md. Fixture instructions are data and are
not installed or executed. No network, installer hooks, shell metadata evaluation,
MCP registration, dependency installation or user-global cache is used by the byte
layer.

Paths use a conservative printable ASCII/portable subset. Traversal, absolute or
ambiguous paths, symlinked root ancestors/directories/leaves, hard links, duplicate
and file/directory/case-prefix aliases are refused. Only declared regular files
are returned, in copied byte buffers verified against the caller's fixed byte
expectation. Unrelated source entries are not delivered; this primitive does not
claim to perform the future full canonical bundle inventory. Local resource caps
are 10 MiB per file, 128 entries and 64 MiB total; these are capacity limits, not
new wire semantics.

Filesystem access reuses the lazy macOS/Linux descriptor-relative native helper.
Bounded regular-file reads inspect type before opening, then verify type/link
count and size on the opened descriptor. Reads are bounded against growth. A
private owned byte store addresses individual objects by raw-byte SHA256 only;
this is not the canonical `sha256/<bundleDigest>` bundle addressing. Writes use
private exclusive temporary files, flush complete bytes, and publish by atomic
exclusive rename (Darwin renameatx_np/RENAME_EXCL, Linux
renameat2/RENAME_NOREPLACE) without replacing an existing name. Permissions are
set and verified as 0600 on the descriptor before any bytes are written. Existing
corruption is an error, never an
automatic repair. Root-path replacement cannot redirect operations away from the
opened root. Offline reads have no fetch or current-content fallback.

The helper uses Bun FFI and is limited to the existing supported macOS/Linux
64-bit environments. It is not OS isolation from malicious same-user processes.
There is no intermediate hard-link publication state. A deterministic child killed
immediately after the publish syscall leaves the single-link complete object
readable. Foreign hard links and old/internal-looking linked remnants remain
rejected; their names alone do not authorize automatic repair. Callers must not
treat a
read failure as permission to skip verification or deliver another version.

Focused Intel macOS checks: 53 pass, 0 fail, 165 assertions across the new byte
suite and existing native anchor/sync suites, about two seconds. Typecheck and
formatting pass. Ten removal proofs fail by assertion for missing byte digest,
traversal, directory no-follow, collision, offline recheck, license,
non-replacing publication, private-mode setup, interruption-safe publication, and
strict assertion-diagnostic evidence. Sources are restored after each proof.
Reproduce with
`node scripts/skill-bytes-revert.mjs`; the assertion-failure ledger is written to
`.tmp/skill-bytes-revert-evidence.json`. The existing
hosted macOS native gate now also runs this byte suite; no workflow permission,
job, release trigger or package version is changed. Full local heavy gates are
not run while website audit/timing slots are reserved; hosted CI remains separate
evidence at the eventual exact PR SHA.

Wire agreement is recorded against website proposal
41c15cea3763a79987bc18f8655db7030b7dc554. Exact supplied raw canonical vectors were
verified, including the 1069-byte candidate digest
8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c.
No product canonical encoder is implemented here; consume the website-generated
helper when available. Actual on-demand instruction delivery, immutable run
selection/resume, authorization, cancellation observation and result audiences
remain unimplemented/unverified. No full feature acceptance is claimed.

## Review corrections

At prior PR head `3793686`, ARM publication tests failed with
`openat read failed (errno 13)` (EACCES) on newly created cache objects. The writer
now enforces and verifies 0600 before data write;
a restrictive-creation-mask regression exercises this on the local machine.
The precise cause remains unconfirmed; the variadic creation-mode ABI is a
hypothesis. Native ARM revalidation is pending, and no test, time limit or
permission policy is relaxed.

The initial license removal-proof claim was invalid: its fixture was derived from
the production expected-file list and could fail setup before the assertion.
That claim is retracted. Fixtures now independently copy SKILL.md and LICENSE;
the shared proof helper requires an actual Bun assertion diagnostic, with an
end-to-end false-positive regression. All ten removals were rerun with restored
source and positive tests. This corrects evidence, not a demonstrated license
bypass in the initial implementation.

The former hard-link publication interruption window is eliminated by exclusive
rename, without relaxing hard-link/corruption checks. Filesystems lacking atomic
no-replace rename fail explicitly; there is no overwriting/link fallback.

-codex
