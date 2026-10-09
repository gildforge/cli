# Guest root filesystem for the microVM backends, any architecture (the
# docker host's). Same package set and layout as the Firecracker image
# (blue.git build-ubuntu.sh): Ubuntu 24.04, ca-certificates, git, iproute2,
# unzip, bun, the runtime user, /workspace; plus python3 (fixture agents) and
# busybox (udhcpc for NAT networking). Not here: rustup and deka (add per image).
# scripts/build-vm-guest.sh turns it into an ext4 image without root on the host.
FROM ubuntu:24.04
ARG BUN_VERSION=1.3.13
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git iproute2 unzip curl python3 busybox-static \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/aarch64/') \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip" \
 && unzip -p /tmp/bun.zip "*/bun" > /usr/local/bin/bun && chmod 755 /usr/local/bin/bun && rm /tmp/bun.zip
RUN printf 'root:x:0:0:root:/root:/bin/sh\nruntime:x:1000:1000:gild runtime:/workspace:/bin/sh\n' > /etc/passwd \
 && printf 'root:x:0:\nruntime:x:1000:\n' > /etc/group \
 && mkdir -p /workspace /artifacts /toolchain \
 && printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig
COPY init-gild.sh /init-gild.sh
COPY gild-guest-agent /usr/local/bin/gild-guest-agent
RUN chmod 755 /init-gild.sh /usr/local/bin/gild-guest-agent
