const YOUTUBE_LINK_REGEX =
  /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s<>"']*v=[\w-]{6,}|shorts\/[\w-]{6,}|live\/[\w-]{6,}|embed\/[\w-]{6,})|youtu\.be\/[\w-]{6,})[^\s<>"']*/i;

const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm"];

const HELP_TEXT =
  "Send me a YouTube link and I will fetch MP4 download links for you.";

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
      service: "telegram-youtube-mp4-downloader",
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
      "Send a YouTube link and I will return MP4 download options via RapidAPI.",
      env,
    );
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(chatId, HELP_TEXT, env);
    return;
  }

  const youtubeUrl = extractYouTubeUrl(text);
  if (!youtubeUrl) {
    await sendMessage(
      chatId,
      "I could not find a YouTube URL in your message. Please send a full link.",
      env,
    );
    return;
  }

  await telegramRequest(env, "sendChatAction", {
    chat_id: chatId,
    action: "upload_video",
  });

  try {
    const media = await fetchYouTubeMedia(youtubeUrl, env);
    await deliverMediaToTelegram(chatId, youtubeUrl, media, env);
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unexpected processing error";
    await sendMessage(chatId, `Failed to download media: ${messageText}`, env);
  }
}

async function fetchYouTubeMedia(youtubeUrl, env) {
  return fetchFromRapidApi(youtubeUrl, env);
}

async function fetchFromRapidApi(youtubeUrl, env) {
  const rapidApiKey = env.RAPIDAPI_KEY;
  const endpoint =
    env.RAPIDAPI_ENDPOINT ||
    "https://youtube-to-mp4.p.rapidapi.com/url-title";
  const host = env.RAPIDAPI_HOST || new URL(endpoint).hostname;
  const title = (env.RAPIDAPI_TITLE || "Telegram MP4 Download").trim();

  if (!rapidApiKey) {
    throw new Error("RAPIDAPI_KEY is missing in Worker secrets.");
  }

  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set("url", youtubeUrl);
  if (title) {
    requestUrl.searchParams.set("title", title);
  }

  const response = await fetch(requestUrl.toString(), {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "x-rapidapi-key": rapidApiKey,
      "x-rapidapi-host": host,
    },
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
      "RapidAPI returned no downloadable media links for this YouTube URL.",
    );
  }

  return media;
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
  if (isYouTubePageUrl(lower)) {
    return false;
  }

  const hasKnownExtension = VIDEO_EXTENSIONS.some((ext) =>
    lower.includes(ext),
  );

  return (
    hasKnownExtension ||
    lower.includes("mime=video") ||
    lower.includes("video%2fmp4") ||
    lower.includes("googlevideo.com")
  );
}

function isVideoUrl(value) {
  const lower = value.toLowerCase();
  return (
    VIDEO_EXTENSIONS.some((ext) => lower.includes(ext)) ||
    lower.includes("mime=video") ||
    lower.includes("video%2fmp4") ||
    lower.includes("googlevideo.com")
  );
}

function isYouTubePageUrl(lowerUrl) {
  return (
    lowerUrl.includes("youtube.com/watch") ||
    lowerUrl.includes("youtube.com/shorts/") ||
    lowerUrl.includes("youtube.com/live/") ||
    lowerUrl.includes("youtu.be/")
  );
}

async function deliverMediaToTelegram(chatId, sourceUrl, media, env) {
  const caption = `YouTube source: ${sourceUrl}`;
  const videos = media.videoUrls.slice(0, 5);
  const others = media.photoUrls.slice(0, 5);

  try {
    if (videos.length > 0) {
      await telegramRequest(env, "sendVideo", {
        chat_id: chatId,
        video: pickBestVideoUrl(videos),
        caption,
      });
    } else if (others.length > 0) {
      await sendMessage(
        chatId,
        `MP4 candidates found, but none could be auto-attached. Direct links:\n${others.join("\n")}`,
        env,
      );
    } else if (media.allUrls.length > 0) {
      await sendMessage(
        chatId,
        `Download links:\n${media.allUrls.join("\n")}`,
        env,
      );
    }
  } catch {
    await sendMessage(
      chatId,
      `Telegram could not upload video directly. Here are direct links:\n${media.allUrls.join("\n")}`,
      env,
    );
  }
}

function pickBestVideoUrl(videoUrls) {
  const ranked = [...videoUrls].sort((a, b) => scoreVideoUrl(b) - scoreVideoUrl(a));
  return ranked[0];
}

function scoreVideoUrl(urlValue) {
  const lower = urlValue.toLowerCase();
  let score = 0;
  if (lower.includes("1080")) score += 40;
  if (lower.includes("720")) score += 30;
  if (lower.includes("480")) score += 20;
  if (lower.includes(".mp4")) score += 15;
  if (lower.includes("googlevideo.com")) score += 10;
  if (lower.includes("itag=37")) score += 35;
  if (lower.includes("itag=22")) score += 25;
  if (lower.includes("itag=18")) score += 15;
  return score;
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

function extractYouTubeUrl(text) {
  const match = text.match(YOUTUBE_LINK_REGEX);
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
