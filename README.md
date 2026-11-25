# Peril

Peril is a personal agent you text on iMessage. It runs on its own Sprite, a hardware-isolated Linux VM from Fly.io, and uses Kiro as its brain. It reads your mail and calendar, sets reminders, schedules meetings, runs errands in a browser, and texts you first when something needs you. Anything that reaches another person, commits you, costs money or deletes waits for your 👍.

Peril adapts code and skills from [open-instinct](https://github.com/mariagorskikh/open-instinct) (MIT, Maria Gorskikh). Every adapted file says so in its header, and [NOTICE](NOTICE) carries the license. The design is explained in [docs/architecture.md](docs/architecture.md). Results of the checks run against live services are in [docs/decisions.md](docs/decisions.md).

## What it costs

Every piece has a free tier. Peril is built to stay inside them.

| Need | Service | Free limit |
| --- | --- | --- |
| Computer | Sprite | $1 trial; the Free plan lists $5 of usage a month |
| iMessage | Photon Free | Managed shared number, up to 10 users |
| Brain | Kiro CLI, signed in with your org account | Your org's Kiro credits |
| Gmail and Calendar | Composio, through a Sprites connector | 10,000 tool calls a month |
| Wake-ups | cron-job.org, through a Sprites Custom API connector | 100 API calls a day |
| Browser | agent-browser on the Sprite | Free |
| Search | Built-in DuckDuckGo `web_search` | Free |
| Memory | Markdown files and SQLite FTS5 on the Sprite | Free |
| Voice memos | whisper.cpp on the Sprite | Free |

The Sprite sleeps between messages. Compute is billed only while it is awake.

## Set up Peril

You need a Fly.io account, an iPhone, and a Kiro account from your org. Keep every secret out of chat and out of the repo. Secrets go into Sprites connectors or into files under `~/.peril/secrets` on the Sprite.

1. Install the Sprites CLI and sign in:

	```sh
	curl https://sprites.dev/install.sh | bash
	sprite login
	sprite create peril
	```

2. Copy the repo onto the Sprite and run the setup script:

	```sh
	sprite exec -s peril -- git clone https://github.com/<you>/peril-personal-agent ~/peril-personal-agent
	sprite exec -s peril -- bash ~/peril-personal-agent/deploy/sprite/setup.sh
	```

	The first run writes `~/.peril/peril.env`. Fill in `PERIL_OWNER_PHONE` and `PERIL_PUBLIC_URL`. Get the URL with `sprite url -s peril`.

3. Sign Kiro in on the Sprite. Open a console, then use the device flow and approve the code on your phone:

	```sh
	sprite console -s peril
	kiro-cli login --use-device-flow
	```

	Choose **Your organization**. Pick model ids from Kiro's `/model` list for `PERIL_CHAT_MODEL` (fast) and `PERIL_DEEP_MODEL` (strongest).

4. Connect iMessage with Photon. Create a project at [app.photon.codes](https://app.photon.codes) and add a webhook for `<PERIL_PUBLIC_URL>/photon`. Put the project id in `PERIL_PHOTON_PROJECT_ID`. Write the two secrets from inside `sprite console -s peril`, so they never pass through chat:

	```sh
	read -rs V && printf %s "$V" > ~/.peril/secrets/photon-project-secret && chmod 600 ~/.peril/secrets/photon-project-secret
	read -rs V && printf %s "$V" > ~/.peril/secrets/photon-webhook-secret && chmod 600 ~/.peril/secrets/photon-webhook-secret
	```

5. Connect Gmail and Calendar. In Composio, connect your Google account. In the Sprites dashboard, open **Connectors**, add **Composio Tools** with your Composio API key, and grant access to Sprites whose names start with `peril`. Inside the Sprite, `curl -s https://api.sprites.dev/v1/gateway/list` prints the connector's `gateway_base_url`. Put it in `PERIL_COMPOSIO_GATEWAY`.

6. Connect cron-job.org for wake-ups. Create a free account and an API key. In the Sprites dashboard, add a **Custom API** connector with base URL `https://api.cron-job.org`, the API key, and auth method `header` with prefix `Bearer`. Put its gateway URL in `PERIL_CRONJOB_GATEWAY`.

7. Rerun `setup.sh`, then check every integration:

	```sh
	sprite exec -s peril -- bash ~/peril-personal-agent/deploy/sprite/setup.sh
	```

	The last section prints `bun run doctor`. Every line should start with `ok`.

8. Text the Photon number from your iPhone. Peril marks the message read, reacts 👀, and answers.

To turn on voice memos, install `ffmpeg` and whisper.cpp on the Sprite, and put a model at `~/.peril/models/ggml-base.bin`.

## Talk to Peril

- Ask it anything. Long jobs go to a deep session on the strongest model, and Peril keeps chatting meanwhile.
- Tap 👍 on an approval text to let it go ahead, or 👎 to stop it. A plain "yes" or "no" works too.
- Text `/fresh` to start a new chat session. Memory carries over.
- When a site asks you for a login code, text the code to Peril. Peril types it into the page, and Kiro never sees it.

## Develop

```sh
bun install
bun test
bun run check
```

`bun packages/server/src/main.ts` runs Peril on your laptop without Photon. Send it a message with `curl -XPOST localhost:8081/dev/say -d '{"text":"hi"}'`. The local port serves only `127.0.0.1`.

## Repository

```text
packages/core       open-instinct's core, ported to Bun: policy, approvals, memory, scheduler, audit, receipts, memory search
packages/tools-mcp  the MCP server Kiro calls; every call passes the policy guard
packages/brain      the ACP client that runs kiro-cli
packages/channel    the iMessage line over Photon webhooks
packages/server     routes, the conductor, wake-ups, watchers, app events, login codes, voice
skills/  steering/  what Kiro reads: Peril's voice and rules, and task playbooks
deploy/sprite/      setup.sh, run.sh, peril.env.example
```
