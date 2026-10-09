# syntax=docker/dockerfile:1
# The `gild spawn --vm` / `gild runner --isolation vm` guest root filesystem.
# Build it with `bun run vm:image` (scripts/build-vm-image.ts), never by hand:
# the build context is the repository root, and the result is one ext4 file.
# Every download is pinned by version and sha256.

# 1. The guest agent, static musl, from this checkout (protocol: src/isolation/guest-protocol.json).
FROM rust:1.99.0-alpine3.22 AS agent
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY src/isolation/guest-protocol.json src/isolation/guest-protocol.json
COPY guest-agent/Cargo.toml guest-agent/Cargo.lock guest-agent/
COPY guest-agent/src guest-agent/src
RUN cd guest-agent && cargo build --release --locked

# 2. The guest userland: what an agent CLI expects to find.
FROM ubuntu:24.04 AS rootfs
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git iproute2 less openssh-client procps \
      python3 ripgrep unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm /tmp/node.tar.xz \
 && curl -fsSLo /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
# Mount points init-gild.sh uses.
RUN mkdir -p /workspace /artifacts
COPY --from=agent /build/guest-agent/target/release/gild-guest-agent /usr/local/bin/gild-guest-agent
COPY guest-agent/init-gild.sh /init-gild.sh
RUN chmod 0755 /init-gild.sh /usr/local/bin/gild-guest-agent

# 3. Pack it into an ext4 image as root, so ownership and setuid bits survive.
FROM debian:trixie-slim AS image
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs \
 && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /rootfs
# Fixed UUID, hash seed and filesystem timestamps, so packing the same tree
# twice gives the same bytes (apt package versions still move with the mirror).
ARG SOURCE_DATE_EPOCH=0
# resolv.conf is a build-time mount above; init-gild.sh bind-mounts over this file.
RUN rm -rf /rootfs/proc/* /rootfs/sys/* /rootfs/dev/* /rootfs/etc/resolv.conf \
 && : > /rootfs/etc/resolv.conf \
 && mb=$(( $(du -sm /rootfs | cut -f1) * 115 / 100 + 64 )) \
 && mkdir /out \
 && E2FSPROGS_FAKE_TIME=${SOURCE_DATE_EPOCH} SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} mke2fs -q -t ext4 -L gild-rootfs \
      -U 6b1d0b9e-3f1a-4c5e-9a57-67696c64766d -E hash_seed=6b1d0b9e-3f1a-4c5e-9a57-67696c64766d,root_owner=0:0 \
      -d /rootfs /out/rootfs.ext4 ${mb}M

FROM scratch
COPY --from=image /out/rootfs.ext4 /rootfs.ext4
