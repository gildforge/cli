#!/usr/bin/env bash
# Live relay smoke test against a real gild server, with real agent runtimes.
#
#   A person posts "@coord-<run> what's 6 × 7? ask bob-<run>" in a brand-new
#   repository channel; the coordinator agent tags bob; bob answers the
#   coordinator; the coordinator relays the answer to the person.
#
# Everything a person does goes through a real terminal: each agent's startup
# dialog (Codex: "Trust this folder?") is answered with Enter through
# `gild attach`, and a mouse click is sent into the agent's terminal before the
# mention arrives. Prints PASS or FAIL with the transcript and timings, then
# stops the sessions and removes the local profiles.
#
# Usage:
#   GILD_SMOKE_HOME=<home of a TEST identity> scripts/live-relay-smoke.sh \
#     [--runtime codex|claude] [--model <id>] [--timeout <s>] [--keep]
#
# Environment:
#   GILD_SMOKE_HOME  HOME whose .config/gild/identity.json is the person posting.
#                    Required, and never your own: the run creates a repo and
#                    two agents for that account.
#   GILD             gild command (default: gild on PATH), e.g.
#                    "bun run $PWD/src/gild.ts" to test a checkout.
#   CODEX_HOME       Codex login to use (default: the real ~/.codex). The
#                    profile turns off that config's MCP servers and plugins.
#   CLAUDE_CONFIG_DIR  Claude Code config to use with --runtime claude.
#
# Codex runs with `-a never -s workspace-write` plus network access, so it can
# run `gild chat send` without an approval prompt; nothing else is allowed out
# of its working directory. Claude runs with only `Bash(gild chat:*)` allowed.
set -u -o pipefail

runtime=codex model='' timeout=240 keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime=$2; shift 2 ;;
    --model) model=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$runtime" in codex|claude) ;; *) echo "--runtime is codex or claude" >&2; exit 2 ;; esac
: "${GILD_SMOKE_HOME:?set GILD_SMOKE_HOME to the HOME of a test identity}"
[ -f "$GILD_SMOKE_HOME/.config/gild/identity.json" ] || { echo "no identity in $GILD_SMOKE_HOME" >&2; exit 2; }
[ "$GILD_SMOKE_HOME" != "${REAL_HOME:-$HOME}" ] || { echo "GILD_SMOKE_HOME must not be your own HOME" >&2; exit 2; }
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export HOME="$GILD_SMOKE_HOME"
read -r -a G <<< "${GILD:-gild}"
gild() { "${G[@]}" "$@"; }
here=$(cd "$(dirname "$0")" && pwd)

run=$(date +%H%M%S)$(printf '%02x' $((RANDOM % 256)))
coord="coord-$run" bob="bob-$run" repo_name="relay-$run"
work="${GILD_SMOKE_DIR:-$PWD/.tmp/live-relay-$run}"
mkdir -p "$work/$coord" "$work/$bob" && chmod 700 "$work"
log="$work/run.log"
t0=$(date +%s)
say() { printf '[%3ss] %s\n' $(( $(date +%s) - t0 )) "$*"; }
fail() { say "FAIL: $*"; result=FAIL; exit 1; }
result=FAIL sessions=()
cleanup() {
  for s in "${sessions[@]}"; do gild stop "$s" >>"$log" 2>&1; done
  if [ "$keep" = 0 ]; then
    for a in "$coord" "$bob"; do gild agent rm "$a" >>"$log" 2>&1; done
    gild agent suspend "$owner/$repo_name" "$coord" >>"$log" 2>&1
    gild agent suspend "$owner/$repo_name" "$bob" >>"$log" 2>&1
  fi
  say "$result  (log and screens: $work)"
}
trap cleanup EXIT

# Approve pending join requests as the person: the same PATCH the Approve
# button sends. The token is read from the identity file and never printed.
approve() {
  python3 -I - "$HOME/.config/gild/identity.json" "$@" <<'PY'
import json,sys,time,urllib.request
ident=json.load(open(sys.argv[1]));tok=ident['apiToken']['token'];base=ident['apiToken']['server']+'/api/v1'
want=set(sys.argv[2:])
def call(path,method='GET',body=None):
    r=urllib.request.Request(base+path,method=method,data=None if body is None else json.dumps(body).encode(),
        headers={'authorization':'Bearer '+tok,'content-type':'application/json','user-agent':'gild-live-relay-smoke'})
    with urllib.request.urlopen(r,timeout=20) as f:return json.load(f)
until=time.time()+60
while want and time.time()<until:
    for r in call('/agents/requests'):
        if r.get('status')=='pending' and r.get('label') in want:
            call('/agents/requests/'+r['id'],'PATCH',{'decision':'approve','grants':['pr']});want.discard(r['label'])
    time.sleep(1)
sys.exit(1 if want else 0)
PY
}

# Drive a detached session the way a person does, through `gild attach` in a
# real PTY: wait for the screen, press Enter on a startup dialog, click.
person() {
  python3 -I - "$1" "${G[@]}" <<'PY'
import os,pty,re,sys,time,select
sid=sys.argv[1];cmd=sys.argv[2:]+['attach',sid]
pid,fd=pty.fork()
if pid==0: os.execvp(cmd[0],cmd)
screen=b'';last=time.time()
def read(t):
    global screen,last
    end=time.time()+t
    while time.time()<end:
        if select.select([fd],[],[],.1)[0]:
            try: got=os.read(fd,65536)
            except OSError: return
            screen+=got;last=time.time()
def text(): return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\s',b'',screen[-20000:])
# Codex draws its trust dialog seconds after its composer, later still when
# the machine is busy: wait for it until the screen has been quiet for 8 s.
trust=rb'Trustthisfolder|trustthefiles|Doyoutrust'
end=time.time()+45
read(2)
while time.time()<end and not re.search(trust,text(),re.I) and time.time()-last<8: read(.5)
if re.search(trust,text(),re.I):
    print('answered the trust dialog with Enter');os.write(fd,b'\r');read(3)
# A click in the agent's window: an SGR mouse press and release.
os.write(fd,b'\x1b[<0;10;5M\x1b[<0;10;5m');read(1)
os.write(fd,b'\x1d');read(1)  # Ctrl-] detaches; the agent keeps running
os.waitpid(pid,0)
PY
}

owner=$(gild auth status 2>>"$log" | awk 'NR==1{print $1}')
[ -n "$owner" ] || fail "no identity in $HOME"
say "run $run as @$owner, runtime $runtime, gild: ${G[*]}"

gild repo create "$repo_name" >>"$log" 2>&1 || fail "repo create"
full="$owner/$repo_name"
say "created $full (brand new)"

for a in "$coord" "$bob"; do
  gild agent join "$a" --sponsor "$owner" --repo "$full" --grants pr >>"$log" 2>&1 &
  joins+=($!)
done
approve "$coord" "$bob" || fail "join requests never appeared to approve"
for p in "${joins[@]}"; do wait "$p" || fail "agent join did not finish"; done
say "joined and approved @$owner/$coord and @$owner/$bob"

file=AGENTS.md; [ "$runtime" = claude ] && file=CLAUDE.md
cat >"$work/$coord/$file" <<EOF
# You are @$coord in the gild channel $full

- People talk to you in the channel. Each message that tags you arrives as a \`[gild] @… mentioned you…\` prompt with the commands to read the history and to reply.
- When a person asks something, pass it to @$bob: run the \`chat send\` command from the prompt with \`@$bob <the question>\`.
- Then tell the person, tagging only them: \`@<person> asked $bob, will report back\` (no @ on $bob).
- When @$bob answers (you will be tagged), relay the answer to the person who asked, tagging only them, and name $bob without the @.
- Keep messages short. Use only the gild commands shown in the prompts.
EOF
cat >"$work/$bob/$file" <<EOF
# You are @$bob in the gild channel $full

- Messages that tag you arrive as a \`[gild] @… mentioned you…\` prompt with the commands to read the history and to reply.
- Answer the question, then reply with the \`chat send\` command from the prompt, tagging whoever asked (usually @$coord).
- If a message only reports or thanks and asks nothing of you, do not reply.
- Keep replies short.
EOF

for a in "$coord" "$bob"; do
  args=()
  if [ "$runtime" = codex ]; then
    args=(--arg=-a --arg=never --arg=-s --arg=workspace-write
      --arg=-c --arg=sandbox_workspace_write.network_access=true
      --arg=-c --arg='mcp_servers={}' --arg=-c --arg='plugins={}')
  else
    args=(--arg=--allowedTools --arg="Bash(${G[*]} chat:*)")
  fi
  gild agent add "$a" --runtime "$runtime" ${model:+--model "$model"} \
    --dir "$work/$a" --channel "$full" "${args[@]}" >>"$log" 2>&1 || fail "agent add $a"
  gild spawn --detach agent "$a" >>"$log" 2>&1 || fail "spawn $a"
  sessions+=("$a")
done
say "spawned both detached"
for a in "$coord" "$bob"; do
  person "$a" | sed "s/^/       $a: /"
done
say "clicked into both terminals"

ask="@$coord what's 6 × 7? ask $bob"
cursor=$(gild chat send "$full" "$ask" 2>>"$log") || fail "post"
posted=$(date +%s)
say "posted #$cursor: $ask"

# Wait for: bob answers @coord with 42, then coord relays 42 to the person.
answered='' relayed=''
while [ $(( $(date +%s) - posted )) -lt "$timeout" ]; do
  gild chat history "$full" --after "$cursor" --json >"$work/after.jsonl" 2>>"$log"
  verdict=$(python3 -I - "$work/after.jsonl" "$owner" "$coord" "$bob" <<'PY'
import json,sys
path,owner,coord,bob=sys.argv[1:]
msgs=[json.loads(l) for l in open(path) if l.strip()]
name=lambda m:m['author']['name']
ans=next((m for m in msgs if name(m)==f'{owner}/{bob}' and '42' in m['body'] and f'@{coord}' in m['body']),None)
rel=ans and next((m for m in msgs if int(m['cursor'])>int(ans['cursor']) and name(m)==f'{owner}/{coord}' and '42' in m['body'] and f'@{owner}' in m['body']),None)
print(('answered ' if ans else '')+('relayed' if rel else ''))
PY
)
  case "$verdict" in *answered*) [ -n "$answered" ] || { answered=$(date +%s); say "bob answered (+$((answered - posted))s)"; } ;; esac
  case "$verdict" in *relayed*) relayed=$(date +%s); say "coordinator relayed (+$((relayed - posted))s)"; break ;; esac
  sleep 3
done
sleep 8  # catch any extra replies (ping-pong) after the relay

echo "---- transcript ($full) ----"
gild chat history "$full" --limit 50 2>>"$log"
echo "----"
extra=$(python3 -I - "$work/after.jsonl" "$owner" <<'PY'
import json,sys
msgs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(sum(1 for m in msgs if '/' in m['author']['name'] and m.get('kind')!='system'))
PY
)
for a in "$coord" "$bob"; do
  gild status "$a" >"$work/$a.status.json" 2>>"$log"
  cp "$HOME/.gild/sessions/$a/output.log" "$work/$a.screen.log" 2>/dev/null
done
[ -n "$relayed" ] || fail "no relay within ${timeout}s (status: $(cat "$work/$coord.status.json" "$work/$bob.status.json" | tr -d '\n' | cut -c1-400))"
say "agent messages after the post: $extra (4 expected: hand-off, ack, answer, relay)"
result=PASS
