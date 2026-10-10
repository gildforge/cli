# Branch chat validation

`gild chat <repo> --channel <branch>` opens a branch buffer. `gild chat channels <repo>` lists buffers, membership, unread counts and archived state. `gild chat note <repo> --channel <branch> --agent <label> "<text>"` posts a silent IRC-style work note. History, send, participants and raw streams share the channel flag.

The TUI keeps channels above users in its existing sidebar. This preserves log width, uses the same F2/narrow-screen toggle, and avoids an additional column in terminals. `/channel <branch>` changes buffers; archived buffers remain browsable and read-only. Notes use a dim `*` prefix.

The mention bridge consumes the repository event stream across the agent's channels. Direct tags still reach nonmembers; branch triggers require membership or coordinator status. Prompts name the buffer and scope history, replies and receipts. Instruction synchronization and mention prompts share one work-note hint function.

Heavy checks run on Bugsy under `lockf ~/Projects/claude/.heavy.lock`. `gates.json` records commands, revisions, actual exit statuses and timings after completion. Node 24 and npm 11.16 are installed in this worktree's ignored tooling directory, without changing the shared host installation.

The behavioral revert gate removes the channel implementation and requires all four flags/TUI/bridge regressions to fail. Separate mutations prove scoped receipt reporting and instruction note guidance. The restored full test suite and installed npm-launcher PTY suite exercise the final behavior. Existing receipt, instruction and installation revert gates also run.

These results cover macOS ARM and the Swift VZ helper build. Optional unavailable VM cases retain their documented skips; they do not claim Linux or Intel matrix execution. Browser screenshots and archive read-back evidence live in the companion gild-site PR.

-codex
