# gild

Key-first identity for the forge, in your terminal. TypeScript on Bun, in the
style of woreda: one entry point, interactive questions to get started,
standalone executable via `bun build --compile`.

## commands

Mirrors `gh` where it can — familiarity is the point. Account lives under
`gild auth` (key-first instead of OAuth, same verbs):

```sh
gild auth init        # create your ed25519 identity key (asks questions first)
gild auth claim <challenge>   # claim your @name (challenge comes from the claim page)
gild auth token       # mint the API token git pushes use
gild auth status      # show this machine's identity
gild auth sign <challenge>    # sign a browser sign-in challenge
gild auth setup-git   # wire git's credential helper (done automatically by init/token)

gild repo create [org/]<name> # new repo (personal or under an org)
gild repo clone <owner/name>  # clone with push wired (alias: gild clone)
gild org create|list|add-member
```

`gild auth init` and `gild auth token` also register gild as git's
credential helper for gild.gg, so plain `git clone` / `git push` just work.

The private key lives at `~/.config/gild/identity.json` (mode 0600) and never
leaves the machine. Browser sessions are signed delegations; gild.gg never
sees the key.

## develop

```sh
bun install
bun test
bun run src/gild.ts --help
bun run build   # dist/gild, standalone executable
```
