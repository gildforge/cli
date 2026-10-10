The local mention bridge reports to the forge using the agent's token already
held by its `GildClient`; no additional credential is needed.

- The injection queue reports `held` with its existing `held.reason` while a
  prompt is queued. Reasons describe draft state without sending draft contents.
- The typed callback reports `delivered` only after the prompt and Enter reach
  the PTY.
- The first actual busy/tool hook after delivery reports `read` once. The local
  synthetic `pty_submit` event is excluded. The server also recognizes a reply
  in the message's thread as read.

`ReceiptReporter` debounces updates for 50 ms, suppresses identical or backward
states, and preserves delivered → read order. HTTP calls have a one-second
network deadline. Errors are non-fatal and never block typing or hook handling;
shutdown gives receipt flushing at most one second. A later receipt or thread
reply can advance the server after an earlier network failure.

`gild chat raw owner/repo` forwards the server's receipt frames unchanged:

```json
{"type":"receipt","cursor":"41","receipt":{"agent":"owner/bob","state":"read","updated_at":"2026-10-10T06:31:04.000Z"}}
```

Regression checks use both an HTTP fake forge with the real injection queue and
spawned PTYs running the actual generated agent hooks. They cover draft and busy
holds, delivered/read order, deduplication, own-token requests and continued work
when receipt POSTs return 503. `bun run test:receipts:revert` removes held reporting,
delivery reporting, busy-hook wiring and failure isolation one at a time, and
requires behavioral failures followed by restored passes.
