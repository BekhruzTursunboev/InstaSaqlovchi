# Telegram Instagram Downloader Bot (Cloudflare Worker)

This project runs a Telegram bot on Cloudflare Workers and downloads Instagram media links through RapidAPI or Apify.

## What this bot does

- Accepts an Instagram URL from Telegram chat.
- Sends it to a provider (RapidAPI first, optional Apify fallback).
- Extracts media URLs from response JSON/text.
- Sends video/photo back to Telegram (or returns direct links as fallback).

## Stack

- JavaScript (Cloudflare Workers runtime)
- Telegram Bot API (webhook mode)
- RapidAPI endpoint (configured via env)
- Apify Actor API (optional fallback)

## Files

- `src/index.js`: Worker webhook + bot logic
- `scripts/set-webhook.mjs`: sets Telegram webhook to your Worker URL
- `wrangler.toml`: Cloudflare Worker config
- `.dev.vars.example`: local env template

## 1) Install dependencies

```bash
npm install
```

## 2) Configure secrets (Cloudflare)

Set required secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put RAPIDAPI_KEY
```

If you want fallback or Apify-only mode:

```bash
npx wrangler secret put APIFY_TOKEN
```

Optional (recommended) secret:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Defaults already in `wrangler.toml`:

- `RAPIDAPI_ENDPOINT=https://instagram-video-downloader13.p.rapidapi.com/index.php`
- `RAPIDAPI_HOST=instagram-video-downloader13.p.rapidapi.com`
- `DOWNLOADER_PROVIDER=AUTO`
- `APIFY_ACTOR_ID=igview-owner/instagram-video-downloader`
- `TELEGRAM_WEBHOOK_PATH=/webhook`

Provider behavior:

- `DOWNLOADER_PROVIDER=AUTO` (default): RapidAPI first, then Apify fallback on quota/rate errors.
- `DOWNLOADER_PROVIDER=RAPIDAPI`: RapidAPI only.
- `DOWNLOADER_PROVIDER=APIFY`: Apify only.

If you switch to another RapidAPI service, change `RAPIDAPI_ENDPOINT` and `RAPIDAPI_HOST`.
If you switch Apify actor, change `APIFY_ACTOR_ID`.

## 3) Deploy

```bash
npx wrangler login
npm run deploy
```

If your CI/Cloudflare build is configured to run `npm start`, this project now maps it to a safe build check (`npm run build`).
Use `npm run deploy` only in a deploy step.

### Cloudflare (Git-based) recommended settings

- Build command: `npm start`
- Deploy command: `npm run deploy`

Required environment secrets:

- `CLOUDFLARE_API_TOKEN` (for deploy step in CI)
- `TELEGRAM_BOT_TOKEN`
- `RAPIDAPI_KEY` and/or `APIFY_TOKEN`

After deploy, note your Worker URL, for example:

- `https://telegram-instagram-downloader-bot.<subdomain>.workers.dev`

## 4) Set Telegram webhook

Run this from your local machine:

```bash
WORKER_URL="https://telegram-instagram-downloader-bot.<subdomain>.workers.dev" npm run set:webhook
```

If you use a secret token, export `TELEGRAM_WEBHOOK_SECRET` before running the command.

## 5) Optional: GitHub -> Cloudflare auto deploy

If you want deployment from GitHub Actions, add these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `RAPIDAPI_KEY` and/or `APIFY_TOKEN`

Workflow file is included at `.github/workflows/deploy.yml` and deploys on push to `main`.

Required repo secrets for CI deploy:

- `CLOUDFLARE_API_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `RAPIDAPI_KEY` and/or `APIFY_TOKEN`

## 6) Test

In Telegram, send:

- `/start`
- an Instagram URL like `https://www.instagram.com/reel/.../`

## Local dev

Copy `.dev.vars.example` to `.dev.vars` and set real values:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

## Troubleshooting

- `Failed to download media: RapidAPI error ... quota ...`
  - Your RapidAPI plan/key likely hit limit. Set `APIFY_TOKEN` for fallback or upgrade/replace RapidAPI plan.
- `Apify request failed ...`
  - Verify `APIFY_TOKEN`, `APIFY_ACTOR_ID`, and remaining Apify credits.
- `Telegram ... failed: wrong file identifier/http url specified`
  - Telegram could not fetch that media URL directly. Bot will send direct links as fallback.
- No media returned
  - Some private/restricted/expired Instagram URLs cannot be parsed by third-party APIs.

## Security note

- Do not commit API keys or bot token to git.
- Rotate any key/token that was shared publicly.
