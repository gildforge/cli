#!/bin/sh
# Build the macOS `vm` backend launcher and sign it ad hoc with the
# Virtualization entitlement (no developer identity, no keychain, no dialog).
#   scripts/build-vz-helper.sh [<out>]     default: dist/gild-vz
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$here/dist/gild-vz}
mkdir -p "$(dirname "$out")"
xcrun swiftc -O -framework Virtualization -framework Security \
  "$here/vz/gild-vz.swift" -o "$out"
codesign --force --sign - --entitlements "$here/vz/gild-vz.entitlements" "$out"
codesign -d --entitlements - "$out" 2>/dev/null | grep -q com.apple.security.virtualization
# Hosted CI Macs are VMs without nested virtualization; check where VZ can run.
if [ "$(sysctl -n kern.hv_support 2>/dev/null)" = 1 ]; then "$out" check; else echo "built $out (no hypervisor here; skipped check)"; fi
