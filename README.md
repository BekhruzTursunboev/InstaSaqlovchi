# Telegram YouTube MP4 Bot (Cloudflare Worker)

This project runs a Telegram bot on Cloudflare Workers and converts YouTube links to downloadable MP4 links via RapidAPI.

## What this bot does

- Accepts a YouTube URL from Telegram chat.
- Calls RapidAPI (`youtube-to-mp4.p.rapidapi.com`).
- Extracts MP4/video links from the API response.
- Sends a video to Telegram when possible, otherwise sends direct download links.

## Stack

- JavaScript (Cloudflare Workers runtime)
- Telegram Bot API (webhook mode)
- RapidAPI YouTube-to-MP4 API

## Files

- `src/index.js`: Worker webhook + bot logic
- `scripts/set-webhook.mjs`: set Telegram webhook to your Worker URL
- `wrangler.toml`: Cloudflare Worker config
- `.dev.vars.example`: local env template

## 1) Install

```bash
npm install
```

## 2) Local run (already prepared)

`.dev.vars` is already created locally for this workspace with your bot token and RapidAPI key.

Run:

```bash
npm run dev
```

Health check:

- open `http://127.0.0.1:8787/`

## 3) Deploy to Cloudflare

```bash
npx wrangler login
npm run deploy
```

## 4) Set Cloudflare Worker secrets

Even though local `.dev.vars` exists, production still needs secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put RAPIDAPI_KEY
```

Optional:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Configured defaults in `wrangler.toml`:

- `RAPIDAPI_ENDPOINT=https://youtube-to-mp4.p.rapidapi.com/url-title`
- `RAPIDAPI_HOST=youtube-to-mp4.p.rapidapi.com`
- `RAPIDAPI_TITLE=Telegram MP4 Download`
- `TELEGRAM_WEBHOOK_PATH=/webhook`

## 5) Set Telegram webhook

After deploy, run:

```bash
WORKER_URL="https://telegram-youtube-mp4-bot.<subdomain>.workers.dev" npm run set:webhook
```

If you set webhook secret, include `TELEGRAM_WEBHOOK_SECRET` in your env before running.

## 6) Test in Telegram

Send:

- `/start`
- any YouTube URL (`youtube.com/watch?v=...` or `youtu.be/...`)

## GitHub Actions deploy

Workflow file: `.github/workflows/deploy.yml`

Required repository secret:

- `CLOUDFLARE_API_TOKEN`

## Important troubleshooting

- If bot replies with `RapidAPI error: You are not subscribed to this API.`
  - Subscribe your RapidAPI app to `youtube-to-mp4` first.
  - Verified on **March 17, 2026** that this error appears when subscription is missing.
- If Telegram cannot upload the URL directly
  - Bot will return direct links, and you can download manually.

## Security note

- Your bot token and API key were shared publicly in chat.
- Rotate both tokens after setup to stay safe.
