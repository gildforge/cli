#!/bin/sh
# One-time owner setup for gild's `host` isolation tier: a dedicated,
# unprivileged OS user that runs workflow steps (or one agent), so a step
# cannot read the owner's home, write outside its checkout, or reach the LAN.
#
#   sudo scripts/host-user-setup.sh <user> <owner> --agent <gild-guest-agent> [--dry-run] [--os linux|macos]
#
#   <user>   the dedicated account to create, e.g. gild-runner or gild-agent-ava
#   <owner>  the login that runs `gild runner` / `gild spawn` (it joins <user>'s group)
#   --agent  a gild-guest-agent build for THIS OS (copied to a root-owned path)
#   --dry-run  print every command instead of running it (no root needed)
#
# What it does (both OSes):
#   1. creates group <user> and user <user> (no login shell, no password);
#   2. adds <owner> to group <user> (log out and in afterwards);
#   3. creates <base>/home (0700, the user's own) and <base>/work (2770,
#      owner:<user>), where gild stages each job's checkout;
#   4. installs the agent root-owned at /usr/local/libexec/gild/gild-guest-agent;
#   5. lets <owner> run exactly that agent as <user> without a password
#      (/etc/sudoers.d/gild-host-<user>, checked with visudo first);
#   6. denies <user> the LAN, tailnet, link-local/metadata and loopback
#      (nftables `meta skuid` on Linux, a pf anchor `user` rule on macOS),
#      persisted by a systemd unit / LaunchDaemon;
#   7. writes /etc/gild/host-users/<user>.json, which `gild status` reads to
#      report the tier as configured.
# Undo: see the matching `remove` lines printed at the end.
set -eu

usage() { echo "usage: sudo $0 <user> <owner> --agent <path> [--dry-run] [--os linux|macos]" >&2; exit 2; }
user=${1:-} owner=${2:-}
[ -n "$user" ] && [ -n "$owner" ] || usage
shift 2
agent='' dry=0
case $(uname -s) in Darwin) os=macos ;; *) os=linux ;; esac
while [ $# -gt 0 ]; do
  case $1 in
    --agent) agent=${2:-}; shift ;;
    --dry-run) dry=1 ;;
    --os) os=${2:-}; shift ;;
    *) usage ;;
  esac
  shift
done
[ -n "$agent" ] || usage
case $user in gild-*) ;; *) echo "the user name must start with gild- (got $user)" >&2; exit 2 ;; esac
echo "$user" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || { echo "invalid user name $user" >&2; exit 2; }
[ "$os" = linux ] || [ "$os" = macos ] || usage
if [ "$dry" = 0 ]; then
  [ "$(id -u)" = 0 ] || { echo "run with sudo (or add --dry-run to see the commands)" >&2; exit 1; }
  [ -x "$agent" ] || { echo "agent $agent is not an executable file" >&2; exit 1; }
  id -u "$owner" >/dev/null 2>&1 || { echo "no such owner $owner" >&2; exit 1; }
fi

run() { if [ "$dry" = 1 ]; then echo "$*"; else "$@"; fi; }
# write <path> <mode>: stdin becomes the file (root-owned).
write() {
  if [ "$dry" = 1 ]; then echo "cat > $1 <<'EOF'  # mode $2"; cat; echo "EOF"; return; fi
  umask 077; cat > "$1.new"; chmod "$2" "$1.new"; mv "$1.new" "$1"
}

libexec=/usr/local/libexec/gild
installed=$libexec/gild-guest-agent
if [ "$os" = linux ]; then base=/var/lib/gild-host/$user; else base=/Users/Shared/gild-host/$user; fi
denied4='127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16'
denied6='::1, fc00::/7, fe80::/10'

if [ "$os" = linux ]; then
  getent group "$user" >/dev/null 2>&1 || run groupadd --system "$user"
  id -u "$user" >/dev/null 2>&1 || run useradd --system --gid "$user" --home-dir "$base/home" --no-create-home --shell /usr/sbin/nologin "$user"
  run usermod -a -G "$user" "$owner"
else
  # Hidden service account; ids from the 400-499 range not already taken.
  free_id() { n=401; while dscl . -list "$1" "$2" | awk '{print $2}' | grep -qx "$n"; do n=$((n+1)); done; echo "$n"; }
  if [ "$dry" = 1 ]; then gid='<free gid 401-499>' uid='<free uid 401-499>'; else gid=$(free_id /Groups PrimaryGroupID) uid=$(free_id /Users UniqueID); fi
  if ! dscl . -read "/Groups/$user" >/dev/null 2>&1; then
    run dscl . -create "/Groups/$user"
    run dscl . -create "/Groups/$user" PrimaryGroupID "$gid"
    run dscl . -create "/Groups/$user" RealName "gild host tier ($user)"
  fi
  if ! dscl . -read "/Users/$user" >/dev/null 2>&1; then
    run dscl . -create "/Users/$user"
    run dscl . -create "/Users/$user" UniqueID "$uid"
    run dscl . -create "/Users/$user" PrimaryGroupID "$gid"
    run dscl . -create "/Users/$user" UserShell /usr/bin/false
    run dscl . -create "/Users/$user" NFSHomeDirectory "$base/home"
    run dscl . -create "/Users/$user" RealName "gild host tier ($user)"
    run dscl . -create "/Users/$user" IsHidden 1
    run dscl . -create "/Users/$user" Password '*'
  fi
  run dseditgroup -o edit -a "$owner" -t user "$user"
fi

run install -d -o root -g 0 -m 0755 "$(dirname "$base")"
run install -d -o root -g 0 -m 0755 "$base"
run install -d -o "$user" -g "$user" -m 0700 "$base/home"
run install -d -o "$owner" -g "$user" -m 2770 "$base/work"
run install -d -o root -g 0 -m 0755 "$libexec"
run install -o root -g 0 -m 0755 "$agent" "$installed"

# sudo: exactly this agent, exactly these arguments, as exactly this user.
rule="$owner ALL=($user) NOPASSWD: $installed --stdio --shared"
if [ "$dry" = 1 ]; then
  echo "echo '$rule' > /etc/sudoers.d/gild-host-$user  # mode 0440, after visudo -cf"
else
  printf '%s\n' "$rule" > "/etc/sudoers.d/.gild-host-$user"
  chmod 0440 "/etc/sudoers.d/.gild-host-$user"
  visudo -cf "/etc/sudoers.d/.gild-host-$user"
  mv "/etc/sudoers.d/.gild-host-$user" "/etc/sudoers.d/gild-host-$user"
fi

run install -d -o root -g 0 -m 0755 /etc/gild /etc/gild/host-users
if [ "$os" = linux ]; then
  write "/etc/gild/host-users/$user.nft" 0644 <<NFT
table inet gild_host_$(echo "$user" | tr - _) {
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid "$user" ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
    meta skuid "$user" ip daddr { $denied4 } reject
    meta skuid "$user" ip6 daddr { $denied6 } reject
  }
}
NFT
  write "/etc/systemd/system/gild-host-net-$user.service" 0644 <<UNIT
[Unit]
Description=gild host tier: deny $user the LAN, tailnet, metadata and loopback
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet gild_host_$(echo "$user" | tr - _)
ExecStart=/usr/sbin/nft -f /etc/gild/host-users/$user.nft
ExecStop=/usr/sbin/nft delete table inet gild_host_$(echo "$user" | tr - _)
[Install]
WantedBy=multi-user.target
UNIT
  run systemctl daemon-reload
  run systemctl enable --now "gild-host-net-$user.service"
else
  write "/etc/pf.anchors/gild-host-$user" 0644 <<PF
block return out quick inet proto { tcp udp } from any to { $(echo "$denied4" | tr -d ,) } user $user
block return out quick inet6 proto { tcp udp } from any to { $(echo "$denied6" | tr -d ,) } user $user
PF
  # The stock pf.conf already evaluates anchor "com.apple/*", so no edit to pf.conf.
  write "/Library/LaunchDaemons/gg.gild.host-net.$user.plist" 0644 <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>gg.gild.host-net.$user</string>
  <key>ProgramArguments</key><array>
    <string>/sbin/pfctl</string><string>-E</string>
    <string>-a</string><string>com.apple/gild-host-$user</string>
    <string>-f</string><string>/etc/pf.anchors/gild-host-$user</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  run launchctl bootstrap system "/Library/LaunchDaemons/gg.gild.host-net.$user.plist"
fi

if [ "$dry" = 1 ]; then uidv='<uid>' gidv='<gid>'; else uidv=$(id -u "$user") gidv=$(id -g "$user"); fi
write "/etc/gild/host-users/$user.json" 0644 <<JSON
{"version":1,"user":"$user","uid":$uidv,"gid":$gidv,"owner":"$owner","agent":"$installed","workRoot":"$base/work","network":"lan-denied"}
JSON

cat <<DONE
gild host tier configured for $user (owner $owner). $owner must log out and in once to join group $user.
Check with: gild status
To remove: delete /etc/sudoers.d/gild-host-$user, /etc/gild/host-users/$user.*, $base and the user/group,
and $( [ "$os" = linux ] && echo "systemctl disable --now gild-host-net-$user" || echo "launchctl bootout system/gg.gild.host-net.$user; pfctl -a com.apple/gild-host-$user -F all" ).
DONE
