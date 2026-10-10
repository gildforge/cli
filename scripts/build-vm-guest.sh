#!/bin/sh
# Build the microVM guest without root on the host, entirely inside docker
# (Colima on macOS), for the docker host's architecture:
#   <out>/gild-guest-agent   static musl guest agent (guest-agent/)
#   <out>/rootfs.ext4        guest-agent/rootfs.Dockerfile as an ext4 image
#   <out>/Image              arm64 only: the vz guest kernel (guest-agent/kernel-arm64-vz.config)
# Each stage is skipped when its output exists; delete the file to rebuild it.
#   scripts/build-vm-guest.sh <out> [rootfs size, default 3G]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
size=${2:-3G}
kernel=${KERNEL_VERSION:-6.12.112}

if [ ! -s "$out/gild-guest-agent" ]; then
  # The whole checkout: the agent compiles in src/isolation/guest-protocol.json.
  docker run --rm -v "$here:/src:ro" -v "$out:/out" rust:1-alpine sh -euc '
    apk add -q musl-dev
    CARGO_TARGET_DIR=/build cargo build -q --release --locked --manifest-path /src/guest-agent/Cargo.toml
    cp /build/release/gild-guest-agent /out/gild-guest-agent'
fi
file "$out/gild-guest-agent"

if [ ! -s "$out/rootfs.ext4" ]; then
  ctx="$out/rootfs-context"
  mkdir -p "$ctx"
  cp "$here/guest-agent/rootfs.Dockerfile" "$ctx/Dockerfile"
  cp "$here/guest-agent/init-gild.sh" "$out/gild-guest-agent" "$ctx/"
  docker build -q -t gild-vm-rootfs "$ctx"
  cid=$(docker create gild-vm-rootfs)
  docker export "$cid" | docker run --rm -i -v "$out:/out" alpine:3 sh -euc "
    apk add -q e2fsprogs
    mkdir /r && tar -x -C /r
    printf '127.0.0.1 localhost\n::1 localhost\n' > /r/etc/hosts
    printf 'nameserver 1.1.1.1\n' > /r/etc/resolv.conf
    truncate -s $size /out/rootfs.ext4.part
    # Fixed UUID, hash seed and filesystem timestamps (as guest-agent/image/Dockerfile).
    E2FSPROGS_FAKE_TIME=0 mke2fs -q -t ext4 -L gild-root -U 6b1d0b9e-3f1a-4c5e-9a57-67696c64766d \\
      -E hash_seed=6b1d0b9e-3f1a-4c5e-9a57-67696c64766d,root_owner=0:0 -d /r -F /out/rootfs.ext4.part
    mv /out/rootfs.ext4.part /out/rootfs.ext4"
  docker rm -f "$cid" >/dev/null
fi
ls -l "$out/rootfs.ext4"

if [ "$(docker info --format '{{.Architecture}}')" = aarch64 ] && [ ! -s "$out/Image" ]; then
  docker run --rm -v "$here/guest-agent:/src:ro" -v "$out:/out" debian:trixie-slim sh -euc "
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      build-essential flex bison bc curl xz-utils ca-certificates >/dev/null
    cd /root && curl -fsSL https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$kernel.tar.xz | tar -xJ
    cd linux-$kernel
    KCONFIG_ALLCONFIG=/src/kernel-arm64-vz.config make -s ARCH=arm64 allnoconfig
    missing=''
    for o in \$(grep -o '^CONFIG_[A-Z0-9_]*=y' /src/kernel-arm64-vz.config | cut -d= -f1); do
      grep -q \"^\$o=y\" .config || missing=\"\$missing \$o\"
    done
    [ -z \"\$missing\" ] || { echo \"kernel config: did not stick:\$missing\" >&2; exit 1; }
    make -s ARCH=arm64 -j\$(nproc) Image
    cp .config /out/Image.config
    cp arch/arm64/boot/Image /out/Image"
fi
ls -l "$out"
