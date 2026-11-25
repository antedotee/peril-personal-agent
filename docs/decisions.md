# Fact checks against live services

Each row is a question the plan could not answer from documentation. A row moves to "verified" only after a run against the real service, with the evidence named.

| # | Question | Status | Evidence or fallback |
| --- | --- | --- | --- |
| 1 | Kiro org device-flow login works on the Sprite, and ACP `session/new` accepts `_meta.kiro.modelId` | open | Fallback: open-instinct's Pi loop with Gemini's free tier |
| 2 | Kiro sends `session/request_permission` to the ACP client for an untrusted tool | open | Fallback: rely on the policy guard alone, which already blocks every side effect |
| 3 | Kiro uses the `mcpServers` passed in `session/new`, including the `x-peril-scope` header | open | Fallback: a workspace `.kiro/settings/mcp.json` pointing at `http://127.0.0.1:8081/mcp`, scope `owner` |
| 4 | Photon Free lets Peril text the owner first after one inbound message | open | Fallback: the owner's Mac with imessage-kit |
| 5 | Composio's REST API works through the Sprites gateway at `/api/v3.1/tools/execute/{slug}` | open | Fallback: a Custom API connector for `https://backend.composio.dev` with header `x-api-key` |
| 6 | Composio triggers count against the 10,000 monthly tool calls | open | Fallback: Gmail watch through Pub/Sub and Calendar `events.watch` |
| 7 | `agent-browser install --with-deps` works on the Sprite's Ubuntu | open | Fallback: Cloudflare Browser Run, 10 minutes a day |
| 8 | The Sprite pauses between webhooks, and a cron-job.org request wakes it | open | None needed if it holds; the design depends on it |

## Verified locally

- The server boots, `/health` answers, the public port has no `/mcp`, and the local MCP port lists 22 tools (24 once Composio is connected). Run on macOS with `PORT=18080 bun packages/server/src/main.ts`.
- With Kiro signed out, a `/dev/say` message reaches `kiro-cli acp`, the exit is read as a sign-in problem, and the owner gets the sign-in instructions.
- `bun test`: 373 tests pass across core, tools-mcp, brain, channel and server.
