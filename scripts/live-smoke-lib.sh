# Shared by scripts/live-*-smoke.sh: a person's identity, real agents on a
# real gild server, and a person's terminal. Source it after parsing options
# into: runtime, model, keep, kind (a short run-name prefix).
#
# Environment: GILD_SMOKE_HOME (required, a TEST identity's HOME), GILD (gild
# command, default gild), CODEX_HOME (default the real ~/.codex),
# GILD_SMOKE_DIR (work dir).
set -u -o pipefail
case "$runtime" in codex|claude) ;; *) echo "--runtime is codex or claude" >&2; exit 2 ;; esac
: "${GILD_SMOKE_HOME:?set GILD_SMOKE_HOME to the HOME of a test identity}"
[ -f "$GILD_SMOKE_HOME/.config/gild/identity.json" ] || { echo "no identity in $GILD_SMOKE_HOME" >&2; exit 2; }
[ "$GILD_SMOKE_HOME" != "$HOME" ] || { echo "GILD_SMOKE_HOME must not be your own HOME" >&2; exit 2; }
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export HOME="$GILD_SMOKE_HOME"
read -r -a G <<< "${GILD:-gild}"
gild() { "${G[@]}" "$@"; }

run=$(date +%H%M%S)$(printf '%02x' $((RANDOM % 256)))
work="${GILD_SMOKE_DIR:-$PWD/.tmp/live-$kind-$run}"
mkdir -p "$work" && chmod 700 "$work"
log="$work/run.log"
t0=$(date +%s)
say() { printf '[%3ss] %s\n' $(( $(date +%s) - t0 )) "$*"; }
since() { echo "+$(( $(date +%s) - $1 ))s"; }
result=FAIL sessions=() agents=() owner='' full=''
fail() { say "FAIL: $*"; result=FAIL; exit 1; }
cleanup() {
  for s in "${sessions[@]}"; do
    gild status "$s" >"$work/$s.status.json" 2>>"$log"
    cp "$HOME/.gild/sessions/$s/output.log" "$work/$s.screen.log" 2>/dev/null
    gild stop "$s" >>"$log" 2>&1
  done
  if [ "$keep" = 0 ]; then
    for a in "${agents[@]}"; do
      gild agent rm "$a" >>"$log" 2>&1
      [ -n "$full" ] && gild agent suspend "$full" "$a" >>"$log" 2>&1
    done
  fi
  say "$result  (log and screens: $work)"
}
trap cleanup EXIT

owner=$(gild auth status 2>>"$log" | awk 'NR==1{print $1}')
[ -n "$owner" ] || fail "no identity in $HOME"

# The person's API, with the token read from the identity file, never printed.
# api METHOD PATH [JSON]
api() {
  python3 -I - "$HOME/.config/gild/identity.json" "$@" <<'PY'
import json,sys,urllib.request
ident=json.load(open(sys.argv[1]));tok=ident['apiToken']['token'];base=ident['apiToken']['server']+'/api/v1'
method,path=sys.argv[2],sys.argv[3];body=sys.argv[4] if len(sys.argv)>4 else None
r=urllib.request.Request(base+path,method=method,data=None if body is None else body.encode(),
    headers={'authorization':'Bearer '+tok,'content-type':'application/json','user-agent':'gild-live-smoke'})
with urllib.request.urlopen(r,timeout=30) as f:print(f.read().decode())
PY
}

# join_agents <owner/repo> <label>:<grant>[,<grant>] ... — each agent asks to
# join, and the person approves it with the same PATCH the Approve button sends.
join_agents() {
  local repo=$1; shift
  local pids=() spec label grants
  for spec in "$@"; do
    label=${spec%%:*} grants=${spec#*:}
    gild agent join "$label" --sponsor "$owner" --repo "$repo" --grants "$grants" >>"$log" 2>&1 &
    pids+=($!) agents+=("$label")
  done
  python3 -I - "$HOME/.config/gild/identity.json" "$@" <<'PY' || fail "join requests never appeared to approve"
import json,sys,time,urllib.request
ident=json.load(open(sys.argv[1]));tok=ident['apiToken']['token'];base=ident['apiToken']['server']+'/api/v1'
want=dict(s.split(':',1) for s in sys.argv[2:])
def call(path,method='GET',body=None):
    r=urllib.request.Request(base+path,method=method,data=None if body is None else json.dumps(body).encode(),
        headers={'authorization':'Bearer '+tok,'content-type':'application/json','user-agent':'gild-live-smoke'})
    with urllib.request.urlopen(r,timeout=20) as f:return json.load(f)
until=time.time()+60
while want and time.time()<until:
    for r in call('/agents/requests'):
        if r.get('status')=='pending' and r.get('label') in want:
            call('/agents/requests/'+r['id'],'PATCH',{'decision':'approve','grants':want.pop(r['label']).split(',')})
    time.sleep(1)
sys.exit(1 if want else 0)
PY
  local p; for p in "${pids[@]}"; do wait "$p" || fail "agent join did not finish"; done
}

# add_agent <label> <owner/repo> [extra gild agent add options...]
# Writes nothing itself; put the role file in $work/<label> first.
add_agent() {
  local label=$1 repo=$2; shift 2
  local args=()
  if [ "$runtime" = codex ]; then
    # Approval-free, sandboxed to its folder, with network for gild and git;
    # none of the user's MCP servers or plugins (computer use, browsers).
    args=(--arg=-a --arg=never --arg=-s --arg=workspace-write
      --arg=-c --arg=sandbox_workspace_write.network_access=true
      --arg=-c --arg='mcp_servers={}' --arg=-c --arg='plugins={}')
  else
    args=(--arg=--allowedTools --arg="Bash(gild:*) Bash(git:*) Bash(node:*)")
  fi
  gild agent add "$label" --runtime "$runtime" ${model:+--model "$model"} \
    --dir "$work/$label" --channel "$repo" "${args[@]}" "$@" >>"$log" 2>&1 || fail "agent add $label"
  gild spawn --detach agent "$label" >>"$log" 2>&1 || fail "spawn $label"
  sessions+=("$label")
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
