# Canonical manifest/cache consumer — CLI #70

The CLI consumes the website owner's minimal manifest/selection contract and
canonical helper from signed website PR97 commit
`665af2a3e6eb95c67788ca06df5ec5890d93dae0`, based on agreed proposal `41c15ce`.
Only the required generated canonical helper, contract, additive scopes and client
are copied. The helper/contract/client outputs are unchanged from `1f9f960`.
Their exact-commit sources, generator and output hashes were independently
verified against Ava's transfer ledger; receipt is recorded in
`agent-profile-transfer-665af2a.json` (the earlier receipt remains historical). Generated files are preserved byte-for-byte.

The original full scopes output was held because it carried unrelated historical
website/CLI `grantScopes` drift. The website owner resolved it with a separate
`agent-profile-scopes.ts`, preserved byte-for-byte. Existing `src/api/scopes.ts`
is byte-exact CLI base `ca5d606`; grant behavior is unchanged. Consumer tests deny
null/wildcard/unrelated scopes and anonymous principals, allow only the explicitly
named feature scope, and preserve legacy grant/check semantics. These constants
remain separate from issuance SCOPES; no token issuance or live route is added.
The copied client retains its existing
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

Lightweight Intel macOS checks: 73 tests pass, zero fail, 307 assertions across
eight consumer/native/client/event/import files (3.97 seconds). Typecheck,
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
