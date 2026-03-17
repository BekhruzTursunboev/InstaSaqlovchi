const INSTAGRAM_LINK_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/[^\s<>"']+/i;

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];
const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const HELP_TEXT =
  "Send me an Instagram post/reel URL and I will fetch downloadable media for you.";

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown worker error";
      return json({ ok: false, error: message }, 500);
    }
  },
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const webhookPath = normalizeWebhookPath(env.TELEGRAM_WEBHOOK_PATH);

  if (request.method === "GET" && url.pathname === "/") {
    return json({
      ok: true,
      service: "telegram-instagram-downloader",
      webhookPath,
      now: new Date().toISOString(),
    });
  }

  if (url.pathname !== webhookPath) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const incomingSecret = request.headers.get(
      "x-telegram-bot-api-secret-token",
    );
    if (incomingSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(handleUpdate(update, env));
  return new Response("OK");
}

async function handleUpdate(update, env) {
  const message = update?.message ?? update?.edited_message;
  const chatId = message?.chat?.id;

  if (!chatId) {
    return;
  }

  const text = (message.text ?? message.caption ?? "").trim();

  if (!text) {
    await sendMessage(chatId, HELP_TEXT, env);
    return;
  }

  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      "Send an Instagram link (post/reel) and I will download media using RapidAPI.",
      env,
    );
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(chatId, HELP_TEXT, env);
    return;
  }

  const instagramUrl = extractInstagramUrl(text);
  if (!instagramUrl) {
    await sendMessage(
      chatId,
      "I could not find an Instagram URL in your message. Please send a full link.",
      env,
    );
    return;
  }

  await telegramRequest(env, "sendChatAction", {
    chat_id: chatId,
    action: "upload_video",
  });

  try {
    const media = await fetchInstagramMedia(instagramUrl, env);
    await deliverMediaToTelegram(chatId, instagramUrl, media, env);
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unexpected processing error";
    await sendMessage(chatId, `Failed to download media: ${messageText}`, env);
  }
}

async function fetchInstagramMedia(instagramUrl, env) {
  const provider = (env.DOWNLOADER_PROVIDER || "AUTO").toUpperCase();
  const hasRapidApi = Boolean(env.RAPIDAPI_KEY);
  const hasApify = Boolean(env.APIFY_TOKEN);
  let rapidError = null;

  if (provider === "RAPIDAPI") {
    return fetchFromRapidApi(instagramUrl, env);
  }

  if (provider === "APIFY") {
    return fetchFromApify(instagramUrl, env);
  }

  if (hasRapidApi) {
    try {
      return await fetchFromRapidApi(instagramUrl, env);
    } catch (error) {
      rapidError = error;
      if (!hasApify || !isRapidApiQuotaError(error)) {
        throw error;
      }
    }
  }

  if (hasApify) {
    try {
      return await fetchFromApify(instagramUrl, env);
    } catch (apifyError) {
      if (rapidError) {
        const rapidMessage =
          rapidError instanceof Error ? rapidError.message : String(rapidError);
        const apifyMessage =
          apifyError instanceof Error ? apifyError.message : String(apifyError);
        throw new Error(
          `RapidAPI failed: ${rapidMessage} | Apify failed: ${apifyMessage}`,
        );
      }
      throw apifyError;
    }
  }

  throw new Error(
    "No downloader provider credentials found. Add RAPIDAPI_KEY or APIFY_TOKEN.",
  );
}

async function fetchFromRapidApi(instagramUrl, env) {
  const rapidApiKey = env.RAPIDAPI_KEY;
  const endpoint =
    env.RAPIDAPI_ENDPOINT ||
    "https://instagram-video-downloader13.p.rapidapi.com/index.php";
  const host = env.RAPIDAPI_HOST || new URL(endpoint).hostname;

  if (!rapidApiKey) {
    throw new Error("RAPIDAPI_KEY is missing in Worker secrets.");
  }

  const body = new URLSearchParams({ url: instagramUrl }).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-rapidapi-key": rapidApiKey,
      "x-rapidapi-host": host,
    },
    body,
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `RapidAPI request failed (${response.status}): ${truncate(rawText, 220)}`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = rawText;
  }

  const media = parseMediaUrls(payload, rawText);
  if (media.videoUrls.length === 0 && media.photoUrls.length === 0) {
    const apiError = extractApiError(payload);
    if (apiError) {
      throw new Error(`RapidAPI error: ${apiError}`);
    }
    throw new Error(
      "RapidAPI returned no downloadable media links for this Instagram URL.",
    );
  }

  return media;
}

async function fetchFromApify(instagramUrl, env) {
  const token = env.APIFY_TOKEN;
  const actorId = env.APIFY_ACTOR_ID || "igview-owner/instagram-video-downloader";
  const quality = env.APIFY_QUALITY || "1080";
  const timeoutSecs = Number.parseInt(env.APIFY_TIMEOUT_SECS || "90", 10);

  if (!token) {
    throw new Error("APIFY_TOKEN is missing in Worker secrets.");
  }

  const actorPath = actorId.replace("/", "~");
  const query = new URLSearchParams({
    token,
    format: "json",
    clean: "true",
    timeout: String(Number.isFinite(timeoutSecs) ? timeoutSecs : 90),
  });

  const endpoint = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?${query.toString()}`;
  const payload = {
    instagram_urls: [instagramUrl],
    urls: [instagramUrl],
    quality,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Apify request failed (${response.status}): ${truncate(rawText, 220)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = rawText;
  }

  const media = parseMediaUrls(parsed, rawText);
  if (media.videoUrls.length === 0 && media.photoUrls.length === 0) {
    throw new Error("Apify returned no downloadable media links.");
  }

  return media;
}

function isRapidApiQuotaError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("exceeded")
  );
}

function parseMediaUrls(payload, rawText) {
  const urlSet = new Set();
  walkForUrls(payload, urlSet);
  walkForUrls(rawText, urlSet);

  const filtered = Array.from(urlSet).filter(isLikelyMediaUrl);
  const unique = Array.from(new Set(filtered));

  const videoUrls = unique.filter(isVideoUrl);
  const photoUrls = unique.filter((value) => !isVideoUrl(value));

  return { videoUrls, photoUrls, allUrls: unique };
}

function walkForUrls(value, collector) {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    for (const found of extractHttpUrls(value)) {
      collector.add(found);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkForUrls(item, collector);
    }
    return;
  }

  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      walkForUrls(entry, collector);
    }
  }
}

function extractHttpUrls(value) {
  const results = value.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? [];
  return results.map(cleanUrl).filter(Boolean);
}

function cleanUrl(value) {
  return value.replace(/[),.;]+$/, "");
}

function isLikelyMediaUrl(value) {
  if (!value) {
    return false;
  }

  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return false;
  }

  const lower = value.toLowerCase();
  if (lower.includes("instagram.com/reel/")) {
    return false;
  }
  if (lower.includes("instagram.com/p/")) {
    return false;
  }
  if (lower.includes("instagram.com/tv/")) {
    return false;
  }
  if (lower.includes("instagram.com/stories/")) {
    return false;
  }

  const hasKnownExtension =
    VIDEO_EXTENSIONS.some((ext) => lower.includes(ext)) ||
    PHOTO_EXTENSIONS.some((ext) => lower.includes(ext));

  return hasKnownExtension || lower.includes("cdninstagram");
}

function isVideoUrl(value) {
  const lower = value.toLowerCase();
  return (
    VIDEO_EXTENSIONS.some((ext) => lower.includes(ext)) ||
    (lower.includes("video") && !PHOTO_EXTENSIONS.some((ext) => lower.includes(ext)))
  );
}

async function deliverMediaToTelegram(chatId, sourceUrl, media, env) {
  const caption = `Instagram source: ${sourceUrl}`;
  const videos = media.videoUrls.slice(0, 10);
  const photos = media.photoUrls.slice(0, 10);

  try {
    if (videos.length >= 2) {
      await sendMediaGroup(
        chatId,
        videos.map((item, index) => ({
          type: "video",
          media: item,
          caption: index === 0 ? caption : undefined,
        })),
        env,
      );
    } else if (videos.length === 1) {
      await telegramRequest(env, "sendVideo", {
        chat_id: chatId,
        video: videos[0],
        caption,
      });
    }

    if (photos.length >= 2) {
      await sendMediaGroup(
        chatId,
        photos.map((item, index) => ({
          type: "photo",
          media: item,
          caption: index === 0 && videos.length === 0 ? caption : undefined,
        })),
        env,
      );
    } else if (photos.length === 1 && videos.length === 0) {
      await telegramRequest(env, "sendPhoto", {
        chat_id: chatId,
        photo: photos[0],
        caption,
      });
    }

    if (videos.length === 0 && photos.length === 0 && media.allUrls.length > 0) {
      await sendMessage(
        chatId,
        `Media extracted, but Telegram could not auto-send. Direct links:\n${media.allUrls.join("\n")}`,
        env,
      );
    }
  } catch {
    await sendMessage(
      chatId,
      `Telegram could not upload media directly. Here are direct links:\n${media.allUrls.join("\n")}`,
      env,
    );
  }
}

async function sendMediaGroup(chatId, media, env) {
  if (media.length < 2) {
    return;
  }

  await telegramRequest(env, "sendMediaGroup", {
    chat_id: chatId,
    media,
  });
}

async function sendMessage(chatId, text, env) {
  await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function telegramRequest(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing in Worker secrets.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  if (!response.ok || !parsed?.ok) {
    const description = parsed?.description || truncate(rawText, 220);
    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  return parsed.result;
}

function extractInstagramUrl(text) {
  const match = text.match(INSTAGRAM_LINK_REGEX);
  return match ? cleanUrl(match[0]) : null;
}

function extractApiError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const candidates = ["error", "message", "detail", "description"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  if (typeof payload.status === "string" && payload.status.toLowerCase() === "error") {
    return "API returned status=error";
  }

  return null;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function normalizeWebhookPath(pathValue) {
  const raw = pathValue && pathValue.trim() ? pathValue.trim() : "/webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
