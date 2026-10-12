# Gild launch/enforcement audit at 6818d92212db906a2641dbdafc00672f0af6b0ec

Source inspection only, not a live exploit/credential exposure or a new runtime
certification. No real credentials read, image lookup repeated, tests/CI polled,
provider called, OS/network setup changed or enforcement code added. The separate
new catalog-consumer source review/hosted CI remains with Ava's existing reviewers.
Latest scoped engineering authorization supersedes the Meta-comparison-only pause.

Meta primary reference: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
Relevant principle: untrusted runtime is separated from policy/credential services,
with kernel-authenticated constrained IPC. No Meta code or implementation copied.

## Process, environment and filesystem map

| Process/module | Present role and identity | Implemented checks / verified gaps |
| --- | --- | --- |
| Native parent CLI, src/spawn.ts | User-invoked launcher; owner UID, shell PATH/cwd/profile/argv | Piped/non-TTY runNative at164-174 precedes resolveIdentity176-179. PTY identity resolution reports/bridges but is not task admission. Worker spawn215-268 inherits ambient environment; manual local profile args/env/cwd are not forge approval. |
| spawn-worker.ts, StateReporter, MentionBridge | Candidate host controller/reporting client, same owner UID as ordinary native child | Report/bridge credentials arrive over parent's process IPC67-95, not serialized worker options. Tokens stay in worker-owned client objects714. Worker code is cached user-owned0600 under ~/.gild (spawn.ts31-45); native node/PATH, code, profile/config/log locations remain same-user mutable. No protected OS broker boundary. |
| Native piped/PTY coding CLI, tools and notifier | Untrusted native runtime; ordinary spawn has no UID switch | spawn-native4-16 copies ambient env except listed session variables. spawn-binary57-62 filters only with explicit allowlist, retaining HOME/PATH/USER/SHELL/TMPDIR etc. worker662-668 passes this env to PTY; fallback389-404 uses runNative. Same UID can reach user-owned credential/config/code/files permitted to that user. This is access possibility, not proof of a specific secret read. |
| Adapter observers/hooks/notifier | Untrusted native/guest callbacks and native tool processes | Codex prepare30-63 reads user CODEX_HOME/HOME notify/log config and chains an original notifier; spawn-hook69-83 spawns its arbitrary configured command with inherited env. Claude prepare34-81 writes user-owned0600 settings/plugin files; --bare/--safe-mode preserves disabled-hook semantics. Names/session strings/hook state are telemetry, not OS identity, consent or task authority. |
| Local session control socket/queue/bridge | User-local legacy transport, worker's UID | spawn-sessions50-65 no-follow owner-dir checks0700; worker610 socket0600, framing/64KiB bound455-469. Connection444 onward has no OS peer-UID/PID credential binding; claimed agent/session payload plus same-user filesystem access is not admission. Hook/send/attach/stop/subscribe/sync roles share this legacy endpoint. Queue83-93 types bounded sanitized text; bridge authors/actors263-313 and cursor/delivered persistence481-489 are display/dedup, not authenticated original task provenance or an execution claim. |
| Native dedicated OS-user backend, isolation/host-user.ts | Existing runner isolation adapter, different OS UID via preconfigured sudo rule | hostUserState101-139 rejects same UID/root, checks configured UID/group/root-owned agent and shared-work modes. startHostUser196-214 runs guest-agent --stdio --shared via sudo -n -u; env inside actual child is explicit. Not wired into ordinary native spawn, not proof it is configured/measured here, and not an atomic task/policy broker. Root-owned marker/helper paths/ancestors, switch semantics, shared group and firewall need their own measured integrity; marker-content/file stat checks alone are not a new broker attestation. |
| Host VZ helper + host worker | VM-domain launcher outside guest, owner's host UID; native helper with VZ entitlement | isolation/vz167-234 clones rootfs/work and boots one VZ guest; host/guest kernel boundary can protect unshared host data. This says nothing about a native same-UID agent concurrently accessing the owner or mutating host helper/config/images. Helper/kernel/rootfs and policy code must be protected from the designated runtime under the admitted mode. No host-side credential/action broker is currently registered. |
| Ubuntu gild-guest-agent + coding CLI/tools | Untrusted VM guest domain; init runs guest-agent, PTY child has guest-agent's UID (no drop, normally guest root) | Guest Exec main.rs302-305 clears ambient env; PTY417-431 uses supplied env via execve. Guest code/rootfs and tools are guest-writable; this launcher is not the trusted policy service. guestEnvironment spawn-vm131-147 supplies fixed guest HOME/PATH/etc plus adapter additions/explicit profile allowlist; it is not a credential-specific scrubber. VZ share is a full clone of selected cwd201; approved workspace must exclude broker/config/credentials. |
| VM upload, sync and hook channel | Host-owned content transfer/lifecycle path; guest hook is untrusted input | spawn-vm218-243 reads/transfers any small absolute file argument and small script executable, with no approved-file provenance allowlist. Could transfer sensitive user-selected input; no real secret was inspected. Hook192-217 checks claimed session/op then forwards through local socket, not authenticated task/action. Existing no-follow/digest/Git-metadata sync protections validate effects but cannot grant authority; required project-generation/path policy is still absent. |
| Pinned cache/materializer and runtime catalog helpers | Content/data layer, not a process/security authority | Exact bytes/manifests/license/assets, exclusive publication and private copies are reviewed; launch paths have no materializeSkillBundle/verifyRunSnapshotArtifacts admission caller. Files0400/dirs0700 under same UID are not malicious same-user isolation. Catalog status/evidence/parser and hashes cannot certify actual runtime capability. |

All local/native HOME/config/PATH and clone/argv-file selections must be treated as
potentially agent-writable or sensitive until a mode-specific protected launch verifies
canonical binary/config/image/root ownership and directory identity. No scanning of
real credential directories or user secrets was used to reach these source findings.

## Actual controls versus unsupported claims

Native ordinary host: environment inheritance control is optional; no project-only
filesystem, tool allowlist, exact DNS egress, protected credential store, authenticated
local peer or immutable one-task launch journal is enforced by these launch paths.
Those controls are advisory/unsupported for this mode. Prompt text, short socket
names, private files and report-token IPC cannot upgrade that classification.

Dedicated OS-user runner: separation/checks and a preconfigured owner-home/LAN policy
exist in source; not ordinary interactive/native spawn or a measured current setup.
Kernel/world-readable data/resources remain shared. No per-model/per-tool/task policy
claim follows. Any additional OS user/root/firewall setup still requires authorization.

VM: source implements cloned root/workspace, explicit guest env, protocol compatibility,
owned lifecycle and conservative host sync. VZ network none/block is structural when
no NIC is attached; auto/allow depends on the preconfigured root-owned network marker.
It is not an exact per-hostname/action proxy or independently verified active filter.
Current guest root can run arbitrary available tools; no enforced tool allowlist or
protected in-guest policy/credential daemon. Required unmeasured tool/DNS/project/
delegation/credential boundaries must deny coordinated launch.

Correction to earlier inventory/plan wording: session.checkGuestProtocol179-185 checks
ONLY protocol equality. Guest agent version is displayed on error, not compared.
Published-image installer separately checks manifest CLI version/hash/protocol; an
owner-supplied image has no equivalent automatic version attestation. Exact runtime
admission must bind measured image/helper/harness/version/digest evidence, not accept
an arbitrary hello.version claim. This is a documentation correction, not a new
protocol bug or authorization to alter the image/handshake before agreement.

Resume is native argv/observer state today, not a canonical continuation. Existing
resumeAgent API is legacy suspension control, not resumeAgentExecution. Bridge cursor
replay and detached terminal log snapshots are not execution journal/retry receipts.
There is no atomic coordinated claim before every launch/instruction/context delivery.

## Minimum one-task canonical dependencies before wiring

Use only website-owned signed typed operations: authenticated target generations and
profile/project/runtime/catalog/tuple/evidence pinning, one-task request/owner approval,
claimAgentExecution with taskId/clientRunId/expectedTaskRevisionId/snapshotId, and later
resumeAgentExecution/terminal-result/audience/cancellation/owner uncertainty resolution.
The normative proposal has these names/shapes, but registered client/contracts and
final semantic snapshot/receipt pin placement are not supplied. No parallel serializer,
server policy store, grant fields, credentials or operation enums are defined here.

Required admission handshake:
1. Acquire protected exclusive journal lock for forge+target generation+clientRunId;
validate no-follow owned journal paths, persist/fsync claiming BEFORE any claim request.
Verify immutable task/profile/project/skill/support/catalog and actual adapter capability
without delivering instructions. Required unsupported/unverified mode fails before
claim, adapter config/queue/context/credential use or spawn.
2. Recheck live server target/owner/key/scope/generation, explicit parent grant, task
revision/expiry/revocation/audience and allowed action/project through authenticated
one-task atomic claim. Coordinator cannot claim as target. Only one fresh_launch
response may proceed; existing_execution is read-only with launchAuthority:false.
No generic HTTP retry cache can replay fresh authority. A reference is not a bearer.
3. Observe cancellation, bind the short<=30s fresh permit to immutable selected mode/
execution/snapshot/tuple evidence, persist/fsync attempting BEFORE process start or
skill/private-context delivery. Lost reply/timeout/crash after claiming/attempting is
launch_uncertain, retained for owner resolution, NEVER automatic rerun/reclaimed count.
Two local processes cannot race into duplicate execution. No host/PTY fallback.
4. Broker accepts only a kernel-verified bound runtime/peer endpoint plus canonical
admitted task/action context. Derive task/identity from protected launch registration,
not supplied names/PIDs/JSON. Validate each concrete action against live policy and
parent scope; default deny unknown tool/path/network/action, stale/revoked/expired
bindings and foreign peers. Revalidate destination/path/actual executable at the
claimed enforced boundary. Guest hook telemetry never authenticates action requests.
5. Broker/credential execution lives OUTSIDE runtime-writable/readable code/config/
files/memory/domain; inject protected credential only in an authorized external action,
never return it to runtime env/argv/file/stdout/events/replay or a general exec API.
Native same-UID mode cannot claim this protection; require a genuinely separate
verified OS-user service or deny any operation/control that depends on it. VM guest
is untrusted, host-side broker stays unshared; bind the actual VM/channel rather than
trust guest UID/session text. No new storage or credential/login setup here.
6. Recheck same execution/snapshot before resume; require canonical fresh_continuation,
write its exclusive continuation journal before delivery; existing/uncertain does not
launch again. Cancellation stops future gated work; cannot promise to retract a tool
already sent or control an unrestricted same-UID process. Terminal upload/recovery
uses separate execution-bound result authorization and current private audience,
never cancelled execution rights or delivered-text provenance as result permission.

First smallest source change ONCE exact fields are agreed: a coordinated admission
entrypoint at the boundary before spawn.ts164/adapter worker616/queue682/startVmChild,
with a protected mode-specific broker adapter and explicit no-authority refusal before
all side effects. Reuse agent-profile canonical types/verifiers, selected-bytes,
bundle-cache/materialize, anchored-fs primitives, native/VM lifecycle and cleanup;
no general credential method. Keep manual legacy transport distinct from protected
coordinated launch, with no silent upgrade of its backlog or profile into authority.

Safe deterministic acceptance fixtures only: fake protected broker value; fake child
observations of env/argv/prepared runtime files/output/events/replay; denied malformed/
foreign task-bound peer/action requests and forbidden tool/path/network before any
credential use or launch callback; pinned license/assets and fake claim/journal crashes/
replay/expiry/revocation/parent-narrowing/cancellation/result-audience cases. Remove each
guard and require actual failing assertion, restore source, then rerun positives.
Injected peer/capability fixtures prove data/action ordering, NOT OS identity isolation.
Same-UID native positive protected-secret claims are intentionally unsupported until
real mode separation is measured; required-control negatives must fail launch.

Actual host/guest skills and coding tools remain separate runtime evidence. Designated
reviewer owns older rootfs/tool lookup. Same Intel Mac native HOST then Ubuntu GUEST
with same agent generation/new immutable selection remains required; no running-process
migration or Linux/arm host substitution. Source recipe preparation may follow audit
and reconciled actual tooling, but builds/boot/install/provision/network/provider/login/
credential changes retain separate approvals and the website serial heavy slot.

-codex
