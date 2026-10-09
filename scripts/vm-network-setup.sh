#!/bin/sh
# Network for gild microVMs and containers: internet egress allowed; the host,
# the LAN (10/8, 172.16/12, 192.168/16), tailnet (100.64/10), link-local incl.
# the cloud metadata address (169.254/16) and other VMs denied. Idempotent.
#
#   sudo scripts/vm-network-setup.sh [up|down] [--slots N] [--persist]
#
# Creates: bridge gildbr0 (172.31.255.1/24) with N tap devices gildtap0..N-1
# owned by $SUDO_USER (isolated from each other), a docker network
# gild-egress on bridge gildbr1 (172.31.254.0/24) when docker is installed, and
# the nftables table `inet gild_vm`. The old `inet gild` table is not touched.
set -eu

action=up slots=16 persist=0 print_unit=0
installed=/usr/local/libexec/gild-vm-network-setup
for a in "$@"; do
  case $a in
    up|down) action=$a ;;
    --persist) persist=1 ;;
    --print-unit) print_unit=1 ;;
    --slots) ;;
    [0-9]*) slots=$a ;;
    *) echo "usage: $0 [up|down] [--slots N] [--persist]" >&2; exit 2 ;;
  esac
done
unit() {
  # Root runs only the root-owned installed copy, never a file in a user-writable checkout.
  cat <<UNIT
[Unit]
Description=gild microVM network
After=network-online.target docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
Environment=SUDO_USER=${user:-runner}
ExecStart=$installed up --slots $slots
[Install]
WantedBy=multi-user.target
UNIT
}
if [ "$print_unit" = 1 ]; then user=${SUDO_USER:-runner}; unit; exit 0; fi
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
user=${SUDO_USER:-}
[ -n "$user" ] && [ "$user" != root ] || { echo "run via sudo from the runner user's account (SUDO_USER is unset)" >&2; exit 1; }

teardown() {
  nft delete table inet gild_vm 2>/dev/null || true
  if command -v iptables >/dev/null 2>&1; then
    iptables -D DOCKER-USER -i gildbr0 -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -o gildbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  fi
  i=0
  while [ $i -lt 256 ]; do
    ip link del "gildtap$i" 2>/dev/null || break
    i=$((i + 1))
  done
  ip link del gildbr0 2>/dev/null || true
  if command -v docker >/dev/null 2>&1; then docker network rm gild-egress >/dev/null 2>&1 || true; fi
}

if [ "$action" = down ]; then
  teardown
  rm -f /etc/sysctl.d/90-gild-vm.conf /etc/systemd/system/gild-vm-network.service "$installed"
  echo "gild vm network removed"
  exit 0
fi

sysctl -qw net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-gild-vm.conf

# Rules first: if they fail (set -e) no bridge or tap exists to leak through.
nft delete table inet gild_vm 2>/dev/null || true
nft -f - <<'RULES'
table inet gild_vm {
  set denied4 {
    type ipv4_addr
    flags interval
    elements = {
      0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
      172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4
    }
  }
  # Guests never reach the host itself (no DNS, no services, no ICMP).
  chain input {
    type filter hook input priority -10; policy accept;
    iifname { "gildbr0", "gildbr1" } drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname { "gildbr0", "gildbr1" } meta nfproto ipv6 drop
    iifname { "gildbr0", "gildbr1" } ip daddr @denied4 drop
    oifname { "gildbr0", "gildbr1" } ct state established,related accept
    oifname { "gildbr0", "gildbr1" } drop
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    iifname { "gildbr0", "gildbr1" } oifname != { "gildbr0", "gildbr1" } masquerade
  }
}
RULES

ip link show gildbr0 >/dev/null 2>&1 || ip link add gildbr0 type bridge
ip addr replace 172.31.255.1/24 dev gildbr0
ip link set gildbr0 up

i=0
while [ $i -lt "$slots" ]; do
  t=gildtap$i
  ip link show "$t" >/dev/null 2>&1 || ip tuntap add dev "$t" mode tap user "$user"
  ip link set "$t" master gildbr0
  bridge link set dev "$t" isolated on 2>/dev/null || echo "warning: kernel lacks bridge port isolation for $t" >&2
  ip link set "$t" up
  i=$((i + 1))
done

if command -v docker >/dev/null 2>&1 && ! docker network inspect gild-egress >/dev/null 2>&1; then
  docker network create --driver bridge --subnet 172.31.254.0/24 \
    -o com.docker.network.bridge.name=gildbr1 \
    -o com.docker.network.bridge.enable_icc=false gild-egress >/dev/null
fi


# Docker sets the iptables FORWARD policy to DROP and only accepts its own bridges,
# so the VM bridge needs an accept in DOCKER-USER (our nft drops above still win:
# they run first and a drop is final).
if command -v iptables >/dev/null 2>&1 && iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  iptables -C DOCKER-USER -i gildbr0 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i gildbr0 -j ACCEPT
  iptables -C DOCKER-USER -o gildbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
    iptables -I DOCKER-USER -o gildbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
fi

if [ "$persist" = 1 ]; then
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -o root -g root -m 0755 "$0" "$installed"
  unit > /etc/systemd/system/gild-vm-network.service
  systemctl daemon-reload
  systemctl enable gild-vm-network.service >/dev/null
fi
echo "gild vm network ready: $slots tap slots owned by $user"
