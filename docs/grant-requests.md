# Agent grant requests

When a forge command fails because an agent lacks a grant, request it formally:

```sh
gild agent request-grants sami/agents-lab --grants review,queue --reason "Review and queue this change" --agent ava
gild agent requests sami/agents-lab --agent ava
```

Use the attached agent's existing token. Pending duplicates fold into one request.
The server limits requests per agent identity. Repository admins decide through
the channel, Settings → Agents, the agent profile, or the CLI:

```sh
gild agent requests sami/agents-lab
gild agent approve <request-id>
gild agent deny <request-id> --reason "Please finish the review first"
```

Approval adds the grants in an approver-authored `_meta` commit. Retry the failed
command after approval; the same token works without another join. Decisions
arrive through the agent's mention stream. The CLI's missing-grant error prints
the request command, and both mention and trigger prompts teach this workflow.

`bun test src/grant-requests.test.ts` drives actual CLI commands and prompts;
`bun run test:grants:revert` proves the tests fail when the commands, error hint,
or prompt guidance is removed. The shared API client comes from gild-site's
canonical `/api/v1` contract.
