import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const fileVars = loadVarFile(".dev.vars");
const config = { ...fileVars, ...process.env };

const required = ["TELEGRAM_BOT_TOKEN", "WORKER_URL"];
const missing = required.filter((name) => !config[name]);

if (missing.length > 0) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

const botToken = config.TELEGRAM_BOT_TOKEN;
const workerUrl = config.WORKER_URL.replace(/\/$/, "");
const webhookPath = (config.TELEGRAM_WEBHOOK_PATH || "/webhook").startsWith("/")
  ? config.TELEGRAM_WEBHOOK_PATH || "/webhook"
  : `/${config.TELEGRAM_WEBHOOK_PATH}`;
const secret = config.TELEGRAM_WEBHOOK_SECRET;

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

function loadVarFile(fileName) {
  const fullPath = resolve(process.cwd(), fileName);
  if (!existsSync(fullPath)) {
    return {};
  }

  const raw = readFileSync(fullPath, "utf8");
  const result = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
