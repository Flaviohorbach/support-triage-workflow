# The n8n version

The same triage as the app, built as an n8n workflow, to compare the two. n8n orchestrates; the app's `/api/classify` route classifies and applies the same rules, so both versions decide the same way.

- `support-triage.json`: webhook → classify → card if needed → alert if urgent → reply.
- `triage-failures.json`: n8n's error workflow, which tells the team on Telegram when a run fails.

## Run it locally

Free self-hosted n8n runs on your machine (no Docker needed):

```bash
npm install n8n
npx n8n import:workflow --input=triage-failures.json
npx n8n import:workflow --input=support-triage.json
npx n8n publish:workflow --id=triageErrors0001
npx n8n publish:workflow --id=triageMain000001
```

Then start it with the environment it reads. n8n 2 blocks `$env` in expressions by default:

```bash
N8N_BLOCK_ENV_ACCESS_IN_NODE=false APP_URL=http://localhost:3000 CLASSIFY_TOKEN=... TRELLO_LIST_ID=... TELEGRAM_OPS_CHAT_ID=... npx n8n start
```

Set the same `CLASSIFY_TOKEN` in the app's `.env.local`, add Trello and Telegram credentials in n8n, and send a message:

```bash
curl -X POST http://localhost:5678/webhook/triage -H "content-type: application/json" -d '{"text":"Vocês aceitam Pix?"}'
```

The Telegram trigger is left out on purpose: a bot has one webhook, which the app uses, and a local n8n cannot receive it without a tunnel.
