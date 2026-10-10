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
# of its working directory. Shared steps live in scripts/live-smoke-lib.sh.
set -u -o pipefail

runtime=codex model='' timeout=240 keep=0 kind=relay
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
. "$(dirname "$0")/live-smoke-lib.sh"
coord="coord-$run" bob="bob-$run" repo_name="relay-$run"
mkdir -p "$work/$coord" "$work/$bob"

say "run $run as @$owner, runtime $runtime, gild: ${G[*]}"

gild repo create "$repo_name" >>"$log" 2>&1 || fail "repo create"
full="$owner/$repo_name"
say "created $full (brand new)"

join_agents "$full" "$coord:pr" "$bob:pr"
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

for a in "$coord" "$bob"; do add_agent "$a" "$full"; done
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
[ -n "$relayed" ] || fail "no relay within ${timeout}s (gild status: $(gild status "$coord" 2>&1 | tr -d '\n' | cut -c1-300))"
say "agent messages after the post: $extra (4 expected: hand-off, ack, answer, relay)"
result=PASS
