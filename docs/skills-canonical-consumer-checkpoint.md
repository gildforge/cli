# Canonical manifest/cache consumer — CLI #70

The CLI consumes the website owner's minimal manifest/selection contract and
canonical helper from signed website PR97 commit
`1f9f9609e333d1de252adc048db398bcd7fa74d1`, based on agreed proposal `41c15ce`.
Only the required generated canonical helper, contract and client are copied.
Their exact-commit sources, generator and output hashes were independently
verified against Ava's transfer ledger; receipt is recorded in
`agent-profile-transfer-1f9f960.json`. Generated files are preserved byte-for-byte.

The proposed full scopes output is held: it contains historical website/CLI
drift that adds `channel:write` to `grantScopes`, unrelated to this feature.
Ava confirmed the difference and requested a minimal owner-generated additive
module. Existing CLI scope issuance/helper behavior is unchanged. No generated
module is hand-edited to bypass the hold. The copied client retains its existing
request/response behavior and adds stable error codes with compatible old
constructor calls; tests cover existing calls and malformed error code entries.

`src/skills/selected-bytes.ts` uses the generated identity/selection functions
before adapting manifest descriptors to the existing local byte layer. It checks
the complete bundle and entry digests, declared license and asset bytes, and
requires supplied byte maps to exactly match the manifest. Every supplied byte
is copied and verified before any cache object is written. Offline reuse rechecks
the immutable manifest/selection and every declared object; missing/corrupt data
fails without fetch, substitution or automatic repair. Local portable path,
collision and capacity checks remain stricter than the general wire schema and
fail explicitly on unsupported inputs.

This is preparatory content access only. The existing private raw-byte object
store remains the storage backend; canonical on-disk `sha256/<bundleDigest>`
bundle layout, source-directory inventory and run materialization are pending.
Returning byte buffers grants no execution/delivery authority. There are no
catalog/network calls, live policy routes, token upgrades, profile/task/claim
schemas, launch wiring, harness delivery or runtime enforcement in this slice.

Lightweight Intel macOS checks: 71 tests pass, zero fail, 266 assertions across
seven consumer/native/client/event/import files (4.07 seconds). Typecheck,
format and diff checks pass. The generated helper produces the exact 16-byte
ASCII, 13-byte UTF8 and 1069-byte ECC vectors, including bundle digest
`8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c`.
The four adapter removals (portable path checks, selection binding, exact byte
set, verification before publication) fail with actual assertions and restore source afterward:
`node scripts/selected-bytes-revert.mjs`. Evidence lives under `.tmp/`.

The existing macOS native gates now also run the selected-byte consumer suite;
Linux already runs all tests. Hosted exact-SHA CI for the resulting consumer
commit is pending. Prior byte-layer clearance/CI at `f1d6213` does not validate
new source. Website retains local heavy-test slots; package version0.6.9,
release workflow and permissions are unchanged. PR71 stays draft held; no merge,
release, deployment, provider session or new credential is authorized.

-codex
