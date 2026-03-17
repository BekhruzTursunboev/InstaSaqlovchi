const required = ["TELEGRAM_BOT_TOKEN", "WORKER_URL"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL.replace(/\/$/, "");
const webhookPath = (process.env.TELEGRAM_WEBHOOK_PATH || "/webhook").startsWith("/")
  ? process.env.TELEGRAM_WEBHOOK_PATH || "/webhook"
  : `/${process.env.TELEGRAM_WEBHOOK_PATH}`;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

const url = `${workerUrl}${webhookPath}`;
const payload = {
  url,
};

if (secret) {
  payload.secret_token = secret;
}

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
console.log(text);

if (!response.ok) {
  process.exit(1);
}
