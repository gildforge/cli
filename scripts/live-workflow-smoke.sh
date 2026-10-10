#!/usr/bin/env bash
# Live REAL-WORK smoke test against a real gild server, with real agents:
#
#   1. A person files an issue in a brand-new private repo and labels it `task`.
#   2. The label wakes the lead agent (`--on issues.labeled:task`), which
#      plans and delegates to the dev agent in the channel.
#   3. dev clones as itself, implements with tests, pushes a branch and opens
#      a PR that closes the issue.
#   4. gild Actions runs `node --test` on a registered runner
#      (`runs-on: [self-hosted, macOS]`, e.g. the owner's runner on bugsy).
#      dev reads the checks.
#   5. lead reviews the diff: it requests changes once, then approves. The
#      person merges, and the merge closes the issue.
#
# Prints each milestone with timings, the channel transcript and the PR's
# reviews, then PASS or FAIL, and cleans up the sessions and profiles.
#
# Usage:
#   GILD_SMOKE_HOME=<home of a TEST identity> scripts/live-workflow-smoke.sh \
#     [--runtime codex|claude] [--model <id>] [--timeout <s>] [--keep]
# The owner needs a runner that takes its private repos, e.g.
#   gild runner add --user <owner> --name <machine> && gild runner start --name <machine>
# Shared environment: see scripts/live-smoke-lib.sh.
set -u -o pipefail

runtime=codex model='' timeout=900 keep=0 kind=workflow
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime=$2; shift 2 ;;
    --model) model=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
. "$(dirname "$0")/live-smoke-lib.sh"
export GIT_CONFIG_NOSYSTEM=1 # no system credential helper (keychain dialogs)
lead="lead-$run" dev="dev-$run" repo_name="work-$run"
mkdir -p "$work/$lead" "$work/$dev"
say "run $run as @$owner, runtime $runtime, gild: ${G[*]}"

# 1. A brand-new private repo with a tiny tested module and CI.
gild repo create "$repo_name" --private >>"$log" 2>&1 || fail "repo create"
full="$owner/$repo_name"
gild clone "$full" "$work/seed" >>"$log" 2>&1 || fail "clone as $owner"
mkdir -p "$work/seed/.github/workflows"
cat >"$work/seed/calc.js" <<'EOF'
// Small arithmetic helpers.
exports.add = (a, b) => a + b
EOF
cat >"$work/seed/calc.test.js" <<'EOF'
const test = require('node:test')
const assert = require('node:assert')
const { add } = require('./calc')
test('add', () => assert.strictEqual(add(2, 3), 5))
EOF
cat >"$work/seed/.github/workflows/ci.yml" <<'EOF'
name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: [self-hosted, macOS]
    steps:
      - uses: actions/checkout@v4
      - run: node --test
EOF
( cd "$work/seed" && git add -A && git -c user.name="$owner" -c user.email="$owner@users.noreply.gild.gg" \
    commit -qm "calc: add, with a test and CI" && git push -q origin HEAD:main ) >>"$log" 2>&1 || fail "seed push"
say "created private $full with calc.js, a test and .github/workflows/ci.yml"

# LEAD_GRANTS=pr,review for a forge without gild-site#82 (review-only agents
# could not post in the channel).
join_agents "$full" "$lead:${LEAD_GRANTS:-review}" "$dev:pr"
say "joined and approved @$owner/$lead (${LEAD_GRANTS:-review}) and @$owner/$dev (pr)"

file=AGENTS.md; [ "$runtime" = claude ] && file=CLAUDE.md
cat >"$work/$lead/$file" <<EOF
# You are @$lead, the lead agent of $full

You are woken by a \`[gild] issue … labeled task\` prompt or by a \`[gild] @… mentioned you…\` prompt. Run gild commands with \`--agent $lead\`.

- **A task issue.** Read it with \`gild issue view\`. Post one short plan in the channel that tags @$dev, e.g. \`@$dev please take #<n>: <plan>. Open a PR that closes #<n>, wait for CI, then tag me.\` That is all you do until dev tags you.
- **dev says a PR is ready.** Read it: \`gild pr view\`, \`gild pr diff\` and \`gild pr checks\` on \`$full#<pr>\`.
  - On your FIRST review of a PR, request one concrete, small improvement, such as one more test case: \`gild pr review $full#<pr> --request-changes -b "<what>" --agent $lead\`. Then tag @$dev in the channel.
  - On a later review, if the change is there and checks passed, approve it: \`gild pr review $full#<pr> --approve -b "<why>" --agent $lead\`. Then tell @$owner in the channel that it is ready to merge.
- Never merge. Keep channel messages short. Tag only whoever must act next.
EOF
cat >"$work/$dev/$file" <<EOF
# You are @$dev, a developer agent on $full

You are woken by a \`[gild] @… mentioned you…\` prompt. Run gild commands with \`--agent $dev\`. Work only inside this folder.

- **A task from @$lead.** Read the issue (\`gild issue view $full#<n> --agent $dev\`). Clone as yourself, if you have not yet: \`gild clone $full repo --agent $dev\`. In \`repo\`, create a branch \`$dev/issue-<n>\`, implement the change with tests, and run \`node --test\` until it passes. Commit, then \`git push -u origin HEAD\`. Open a PR: \`gild pr create $full --head <branch> --title "<title>" -b "Closes #<n>" --agent $dev\`.
- **Then wait for CI.** Check \`gild pr checks $full#<pr> --agent $dev\` every 15 seconds, for up to 5 minutes, until the run finishes. If it fails, fix it and push again.
- **When the checks pass,** tag @$lead in the channel: \`@$lead PR #<pr> for #<n> is ready, checks passed\`.
- **When @$lead requests changes,** make them on the same branch, push, wait for the checks the same way, and tag @$lead again.
- Never merge. Keep channel messages short.
EOF

add_agent "$lead" "$full" --on issues.labeled:task
add_agent "$dev" "$full"
say "spawned lead (on issues.labeled:task) and dev, detached"
for a in "$lead" "$dev"; do person "$a" | sed "s/^/       $a: /"; done
say "answered startup dialogs and clicked into both terminals"

# 2. The person files the issue and labels it.
issue=$(gild issue create "$full" --title "Add a multiply function" \
  -b "Export multiply(a, b) from calc.js, with tests in calc.test.js." --json 2>>"$log" |
  python3 -I -c 'import json,sys;print(json.load(sys.stdin)["number"])') || fail "issue create"
gild issue label "$full#$issue" --add task >>"$log" 2>&1 || fail "label"
labeled=$(date +%s)
say "filed #$issue and labelled it task"

# Poll the forge as the person until the PR is approved.
state() {
  python3 -I - "$HOME/.config/gild/identity.json" "$full" "$owner" "$lead" "$dev" "$issue" <<'PY'
import json,sys,urllib.request
ident=json.load(open(sys.argv[1]));tok=ident['apiToken']['token'];base=ident['apiToken']['server']+'/api/v1'
full,owner,lead,dev,issue=sys.argv[2:]
def get(p):
    r=urllib.request.Request(base+p,headers={'authorization':'Bearer '+tok,'user-agent':'gild-live-smoke'})
    with urllib.request.urlopen(r,timeout=30) as f:return json.load(f)
out=[]
msgs=get(f'/repos/{full}/channel/messages?limit=200')
msgs=msgs.get('messages',msgs) if isinstance(msgs,dict) else msgs
if any(m['author']['name']==f'{owner}/{lead}' and f'@{dev}' in m['body'] for m in msgs):out.append('planned')
pulls=[p for p in get(f'/repos/{full}/pulls?state=all') if p['user']['login'].endswith(dev)]
if pulls:
    p=pulls[0];out.append(f"pr={p['number']}")
    if p.get('merged') or p.get('merged_at'):out.append('merged')
    states=[r['state'] for r in get(f"/repos/{full}/pulls/{p['number']}/reviews")]
    if 'CHANGES_REQUESTED' in states:out.append('changes')
    if 'APPROVED' in states and states.index('APPROVED')>(states.index('CHANGES_REQUESTED') if 'CHANGES_REQUESTED' in states else -1):out.append('approved')
print(' '.join(out))
PY
}
seen=' ' pr=''
while [ $(( $(date +%s) - labeled )) -lt "$timeout" ]; do
  now=$(state 2>>"$log") || now=''
  for m in planned changes approved; do
    case " $now " in *" $m "*) case "$seen" in *" $m "*) ;; *) seen="$seen$m "; say "$m ($(since "$labeled"))" ;; esac ;; esac
  done
  case " $now " in *" pr="*) [ -n "$pr" ] || { pr=$(echo "$now" | sed -E 's/.*pr=([0-9]+).*/\1/'); say "dev opened PR #$pr ($(since "$labeled"))"; } ;; esac
  case "$seen" in *" approved "*) break ;; esac
  sleep 5
done
case "$seen" in *" approved "*) ;; *) fail "no approved PR within ${timeout}s (milestones:$seen pr:${pr:-none})" ;; esac
case "$seen" in *" changes "*) ;; *) say "note: lead approved without requesting changes first" ;; esac

# 5. The person merges; the merge closes the issue.
gild pr checks "$full#$pr" >"$work/checks.txt" 2>>"$log"
gild pr merge "$full#$pr" >>"$log" 2>&1 || fail "merge PR #$pr (checks: $(tr '\n' ' ' <"$work/checks.txt"))"
say "merged PR #$pr ($(since "$labeled"))"
sleep 3
closed=$(gild issue view "$full#$issue" --json 2>>"$log" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["state"])')
[ "$closed" = closed ] || fail "issue #$issue is $closed after the merge"
say "issue #$issue closed by the merge ($(since "$labeled"))"

echo "---- checks (PR #$pr) ----"; cat "$work/checks.txt"
echo "---- reviews ----"
api GET "/repos/$full/pulls/$pr/reviews" | python3 -I -c '
import json,sys
for r in json.load(sys.stdin): print(r["user"]["login"], r["state"], "-", (r.get("body") or "").replace("\n"," ")[:160])'
echo "---- channel ($full) ----"
gild chat history "$full" --limit 60 2>>"$log" | grep -v ' session$'
echo "----"
result=PASS
