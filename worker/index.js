// Word Study Worker: serves the static site (ASSETS) and one API route that turns
// a photo or pasted text of a school word list into structured words.
//
//   POST /api/extract-words   { images: [dataUrl, ...] } or { text: "..." }
//   GET  /api/extract-status  -> { engine: "claude" | "workers-ai" }
//
// Engine: Claude vision when the ANTHROPIC_API_KEY secret is set (accurate on
// sideways, curled, busy workbook pages); otherwise Cloudflare Workers AI as a
// weaker fallback so the feature still works. Callers must present a valid
// Firebase ID token (anonymous auth is fine) so the endpoint is not an open
// proxy; nothing is stored. Raw HTTP is used (no SDK) to keep the Worker
// dependency-free.

const FIREBASE_PROJECT = "spelling-words-671aa";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ALLOWED_ORIGINS = new Set([
  "https://wordstudy.trebor.me",
  "https://denytrebor.github.io",
]);
const originOk = (o) => ALLOWED_ORIGINS.has(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const CLAUDE_MODEL = "claude-sonnet-5-5";
const FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TEXT_CHARS = 20000;
const PER_UID_PER_HOUR = 40;

const SYSTEM_PROMPT = `You transcribe school spelling and vocabulary lists for a teacher's spelling app. The input is a photo of a workbook page (it may be rotated, sideways, curled or busy), pasted text, or both.

Rules, in priority order:
1. Transcribe ONLY what is actually printed. Never invent, correct, complete, reorder or define anything. If a definition is not printed next to a word, its definition is "".
2. Read the page in its upright orientation, even if the photo is rotated.
3. A "spelling" entry is a numbered word with no printed definition (prefix, suffix, root groups, Bible book names, etc. all count). A "vocabulary" entry is a word that has a definition printed beside it (after a dash, colon or comma).
4. Keep entries in their printed order and exactly as printed: capitals, hyphens, parenthetical abbreviations like "Joshua (Josh.)" and multi-word entries stay whole. Drop only the leading number.
5. Ignore headings, instructions, quotes, tips, page numbers, copyright lines, exercises and decorative text.
6. If the page shows a Bible verse reference that the week memorises, put it in "verse" (reference only, no text); otherwise "".
7. If a week/lesson number is printed for the list, put it in "week"; otherwise null.
8. If anything is hard to read or you had to guess a letter, add "word (what was unclear)" to "unsure". If the page has gaps in its numbering, mention the missing numbers in "unsure". Do not silently skip words.
9. If the input contains several separate lists/weeks, return one object per week.`;

const SCHEMA = {
  type: "object",
  properties: {
    weeks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          week: { type: ["integer", "null"] },
          verse: { type: "string" },
          spelling: { type: "array", items: { type: "string" } },
          vocabulary: {
            type: "array",
            items: {
              type: "object",
              properties: { word: { type: "string" }, definition: { type: "string" } },
              required: ["word", "definition"],
              additionalProperties: false,
            },
          },
        },
        required: ["week", "verse", "spelling", "vocabulary"],
        additionalProperties: false,
      },
    },
    unsure: { type: "array", items: { type: "string" } },
  },
  required: ["weeks", "unsure"],
  additionalProperties: false,
};

const hourly = new Map(); // best-effort, per isolate

function cors(req) {
  const origin = req.headers.get("Origin");
  const h = { "Vary": "Origin" };
  if (origin && originOk(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) },
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let jwksCache = { at: 0, keys: null };
async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error("jwks");
  jwksCache = { at: Date.now(), keys: (await r.json()).keys };
  return jwksCache.keys;
}

// Returns the Firebase uid, or null when the token is missing/invalid.
async function verifyFirebaseToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== "RS256") return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== FIREBASE_PROJECT || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT}`) return null;
    if (!payload.sub || payload.exp < now || payload.iat > now + 300) return null;
    const jwk = (await getJwks()).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
    return ok ? payload.sub : null;
  } catch (e) {
    return null;
  }
}

function overLimit(uid) {
  const hour = Math.floor(Date.now() / 3600e3);
  const k = uid + ":" + hour;
  const n = (hourly.get(k) || 0) + 1;
  hourly.set(k, n);
  if (hourly.size > 2000) for (const key of hourly.keys()) { if (!key.endsWith(":" + hour)) hourly.delete(key); }
  return n > PER_UID_PER_HOUR;
}

function parseDataUrl(u) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(u || "");
  return m ? { media_type: m[1], data: m[2] } : null;
}

async function viaClaude(env, images, text) {
  const content = [];
  images.forEach((img) => content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } }));
  content.push({
    type: "text",
    text: (text ? `Pasted text:\n"""\n${text}\n"""\n\n` : "") +
      (images.length ? `Transcribe the ${images.length} attached photo(s) of the list` : "Structure the pasted list") +
      " into the required JSON.",
  });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 300));
  const body = await r.json();
  if (body.stop_reason === "refusal") throw new Error("refusal");
  const block = (body.content || []).find((b) => b.type === "text");
  return JSON.parse(block.text);
}

async function viaWorkersAi(env, images, text) {
  const userContent = [{ type: "text", text: SYSTEM_PROMPT + "\n\nReturn JSON only." + (text ? `\n\nPasted text:\n${text}` : "") }];
  images.forEach((img) => userContent.push({ type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } }));
  const out = await env.AI.run(FALLBACK_MODEL, {
    temperature: 0,
    max_tokens: 4000,
    messages: [{ role: "user", content: userContent }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
  });
  const r = out.response;
  return typeof r === "string" ? JSON.parse(r) : r;
}

function clean(result) {
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const weeks = (Array.isArray(result.weeks) ? result.weeks : []).slice(0, 12).map((w) => ({
    week: Number.isInteger(w.week) && w.week > 0 && w.week < 100 ? w.week : null,
    verse: s(w.verse, 120),
    spelling: (w.spelling || []).map((x) => s(x, 200)).filter(Boolean).slice(0, 80),
    vocabulary: (w.vocabulary || [])
      .map((v) => ({ word: s(v.word, 200), definition: s(v.definition, 500) }))
      .filter((v) => v.word).slice(0, 80),
  }));
  return { weeks, unsure: (result.unsure || []).map((x) => s(x, 200)).filter(Boolean).slice(0, 40) };
}

async function extract(req, env) {
  const origin = req.headers.get("Origin");
  if (origin && !originOk(origin)) return json(req, { error: "origin" }, 403);
  const uid = await verifyFirebaseToken(req);
  if (!uid) return json(req, { error: "auth" }, 401);
  if (overLimit(uid)) return json(req, { error: "limit" }, 429);
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) return json(req, { error: "too-big" }, 413);
  let body;
  try { body = await req.json(); } catch (e) { return json(req, { error: "bad-json" }, 400); }
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES).map(parseDataUrl).filter(Boolean);
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_CHARS).trim() : "";
  if (!images.length && !text) return json(req, { error: "empty" }, 400);
  try {
    const engine = env.ANTHROPIC_API_KEY ? "claude" : "workers-ai";
    const raw = engine === "claude" ? await viaClaude(env, images, text) : await viaWorkersAi(env, images, text);
    return json(req, { engine, ...clean(raw) });
  } catch (e) {
    console.log("extract failed:", String(e).slice(0, 400));
    return json(req, { error: "engine" }, 502);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/extract-words") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method !== "POST") return json(req, { error: "method" }, 405);
      return extract(req, env);
    }
    if (url.pathname === "/api/extract-status") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      return json(req, { engine: env.ANTHROPIC_API_KEY ? "claude" : "workers-ai" });
    }
    return env.ASSETS.fetch(req);
  },
};
