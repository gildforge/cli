# Isolation support and demo evidence

The review baseline and this remediation branch start at CLI 0.6.8,
`1853fa644f60c1db7868e86715dbee881a8f5582`. Source support is different from
a verified real-agent session. Unit tests and fixture agents do not prove model
tools, authentication, or internet access inside a real backend.

| Mode | Workflow execution | Interactive `gild spawn` | Remaining evidence/setup |
| --- | --- | --- | --- |
| Current host account | Explicit `--isolation none` | Default PTY spawn | Unisolated; fixture PTY tests cover transport, not a paid model session |
| Dedicated OS user | Implemented `host` backend | Not connected to interactive spawn | User, guest agent, sudo rule and network policy need owner provisioning; the backend's PTY method alone does not expose a spawn mode |
| OCI container | Implemented `container` backend | Absent | Engine, guest agent image and network policy required; backend currently exposes workflow exec only |
| Linux x64 VM | Firecracker backend | `--vm` implemented | Firecracker, KVM, mke2fs, guest image and approved egress required; real-agent rehearsal still required |
| Apple Silicon VM | Virtualization.framework backend | `--vm` implemented | Version-matched helper/image and approved filtered egress required; real-agent rehearsal still required |
| Intel macOS VM | Backend source can use an owner-supplied matching image | No published matching image | Release publishes `linux-x64` and `darwin-arm64` only; this iMac cannot use the arm64 image |

The published Linux recipe includes Node, Bun, Git and basic utilities. The
arm64 guest recipe has a different package set. Neither recipe installs Claude,
Codex or the Gild CLI. Uploading a small fixture script at startup does not
install a model CLI or prove authentication. Host tool paths and host credential
directories are not automatically copied into the guest.

## Automatic sync and recovery

Automatic sync applies working-tree files, directories and links through opened
directory descriptors. Every `.git` component, including nested repository
metadata and worktree `.git` files, is protected. Guest config, hooks, index,
objects and refs are never installed automatically into the host repository.
Source changes can be reviewed and committed on the host. Guest-only commits
remain in the retained guest workspace for a separate reviewed import.

Incomplete final sync stops the VM while keeping its private session directory:
`~/.gild/sessions/<session>.vm-<suffix>/`. The CLI prints that exact path and
writes a private `recovery.json`. On macOS the directory contains `work/`; on
Firecracker it contains `work.ext4`. A transport failure returns an error;
conflicts and protected metadata also retain the workspace. A complete sync
without either condition removes the workspace normally. Recovery directories
remain until the owner has recovered/reviewed the work and removes them; this
change does not silently prune recoverable work or mount disk images.

The descriptor operations use a small, lazy Bun FFI binding to system libc.
VM workers run in the CLI's compiled Bun runtime; ordinary PTY workers retain
Node. Bun documents FFI as experimental. Both supported OS families need their
CI regression gate; macOS-only local checks are not Linux execution evidence.

## Artifact and cache contract

There is no artifact upload service or dependency cache implementation in this
runner. `actions/upload-artifact`, `actions/cache`, and explicit dependency cache
inputs on setup-node/setup-go now fail clearly instead of reporting a successful
no-op. Remove a cache input to run without caching. A workflow's explicit
`continue-on-error` policy still applies to the failed step.

`src/actions/support.ts` is generated from the website and still describes the
older import warnings. The CLI has a local runtime rejection boundary so older
accepted jobs cannot succeed silently. The website owner must update the
canonical support table and regenerate the CLI contract; do not edit another
agent's website checkout to do this.

## Incremental work and exact-version rehearsal

1. Merge/release only after review and all applicable gates. Build the reviewed
   source and record its exact commit, package version and image manifest hashes.
2. Select a host with a matching published VM platform. For this Intel iMac,
   either use ordinary host PTY spawn with its explicit lack of isolation, or
   separately approve an Intel guest-image release/provisioning lane. Do not
   substitute an arm64 image or claim a VM demo from a mock.
3. Prepare a versioned image containing a pinned Gild CLI and explicitly chosen
   model tools. Normalize the Linux/arm64 image package recipes. This requires
   an image-build/release decision, not automatic installation by this patch.
4. Have the owner approve backend provisioning, filtered network policy, and
   narrowly scoped guest authentication. Do not copy host secrets into an image.
   Any paid model session needs separate approval before running it.
5. Rehearse the actual chosen model on a disposable test repository: start,
   receive two distinct issue comments once each, edit ordinary source, sync,
   stop, inspect source/recovery artifacts and verify the exact installed CLI.
   Include a safe incomplete-sync fixture and the unsupported action failures.
6. Add dedicated-user interactive spawn by reusing the existing PTY contract and
   safe copy/sync boundary; add OCI PTY and hook delivery next. Each mode needs a
   real backend test before it is advertised as usable.

No backend installation, OS-user creation, firewall change, credential addition,
paid agent session or release was performed for this remediation.

-codex
