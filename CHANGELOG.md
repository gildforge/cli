# Changelog

## Unreleased

- Forge API failures now print the server's GitHub-compatible `message` (or bootstrap `error`) instead of command-specific prefixes such as `create failed (403)`. Commands still exit 1. Agent collection 4xx failures still print the server reason, exit 1, and stop polling; 5xx responses retry.
- Identity tokens are stored as `{server, token}`. Legacy string tokens are discarded because their issuer is unknown. API commands prove the key again when switching servers; git credential/clone and runner commands refuse mismatched credentials. Re-mint with `gild auth token --server <origin>`.
- Busy runners again show `run #N`, resolved through the canonical Actions overview/job endpoints.
