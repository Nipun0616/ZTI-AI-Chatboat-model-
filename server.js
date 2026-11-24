// ZTI backend — Express + official @google/genai SDK.
// The Gemini API key lives only here (loaded from .env) and is never sent to the browser.

import dotenv from "dotenv";
dotenv.config();
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;

function getEnvConfig() {
  dotenv.config({ override: true });
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  const hasKey = apiKey.length > 0 && apiKey !== "your_key_here";
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  return { apiKey, hasKey, model };
}

/* ------------------------------------------------------------------ */
/* Personality / system instructions                                   */
/* ------------------------------------------------------------------ */

const BASE_PROMPT = `You are ZTI, a warm, sharp and genuinely helpful AI assistant.

How you talk:
- Sound like an intelligent, friendly human, not a manual. Use natural phrasing and contractions.
- Be concise by default. Lead with the answer, then add detail only if it helps.
- Be expressive and adapt your tone to the person: playful when they are casual, focused when they are working, gentle when they are stressed.
- Avoid stiff robotic filler such as "As an AI language model" or "Certainly! Here is...".
- Ask one short clarifying question only when you truly cannot proceed without it.
- Use Markdown when it helps (short lists, tables, code blocks with a language tag). Skip heavy formatting for simple chat.
- When you use live web information, say so naturally. When you are unsure, say so honestly instead of guessing.
- If the user attaches an image or PDF, analyse it carefully and refer to specific details from it.
- Reply in the language the user writes in unless they ask otherwise.`;

const PERSONAS = {
  humanoid: {
    temperature: 0.9,
    extra: `Persona: Humanoid. Be conversational, warm and a little witty, like a smart friend who happens to know a lot.`,
  },
  tutor: {
    temperature: 0.6,
    extra: `Persona: Study Tutor. Teach step by step. Start from the learner's level, explain the "why", use simple analogies and small worked examples, and check understanding with a quick question or practice problem at the end. Be patient and encouraging. For maths and logic, show the working clearly.`,
  },
  coder: {
    temperature: 0.3,
    extra: `Persona: Coding Pro. Act as a senior software engineer. Give correct, idiomatic, runnable code in fenced blocks with a language tag. Explain the key idea briefly, point out edge cases and bugs, and suggest improvements. When debugging, find the root cause first, then show the fix.`,
  },
  creative: {
    temperature: 1.1,
    extra: `Persona: Creative Partner. Be imaginative, vivid and playful. Offer fresh angles, strong voice and unexpected ideas. Brainstorm generously, then help refine the best option.`,
  },
  professional: {
    temperature: 0.5,
    extra: `Persona: Professional. Be polished, precise and businesslike. Structure answers clearly with headings or bullets where useful, keep a neutral tone and prioritise actionable, well-organised output.`,
  },
};

function buildSystemInstruction(persona, jsonMode) {
  const p = PERSONAS[persona] || PERSONAS.humanoid;
  const today = new Date().toDateString();
  let s = `${BASE_PROMPT}\n\n${p.extra}\n\nToday's date is ${today}.`;
  if (jsonMode) {
    s += `\n\nJSON MODE: Respond with valid JSON only. No Markdown fences and no commentary outside the JSON.`;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Request validation helpers                                          */
/* ------------------------------------------------------------------ */

const ALLOWED_INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
const MAX_MESSAGES = 40;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

function buildContents(messages) {
  const contents = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "model" ? "model" : "user";
    const parts = [];

    if (typeof m.text === "string" && m.text.trim()) {
      parts.push({ text: m.text.slice(0, 100000) });
    }

    if (role === "user" && Array.isArray(m.attachments)) {
      for (const a of m.attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
        if (!a || typeof a !== "object") continue;
        if (a.kind === "text" && typeof a.text === "string") {
          const name = String(a.name || "file").slice(0, 120);
          parts.push({ text: `[Attached file: ${name}]\n${a.text.slice(0, 200000)}` });
        } else if (
          a.kind === "inline" &&
          ALLOWED_INLINE.has(a.mimeType) &&
          typeof a.data === "string" &&
          a.data.length > 0
        ) {
          parts.push({ inlineData: { mimeType: a.mimeType, data: a.data } });
        }
      }
    }

    if (parts.length) contents.push({ role, parts });
  }

  // Gemini expects the conversation to start with a user turn.
  while (contents.length && contents[0].role !== "user") contents.shift();
  return contents;
}

function friendlyError(err) {
  const raw = String(err?.message || err || "Unknown error");
  const lower = raw.toLowerCase();
  if (lower.includes("free tier is not available for this project")) {
    return "The Gemini API free tier is not available for this Google Cloud project. Fix: Go to https://aistudio.google.com/apikey and click 'Create API key in new project' (or link billing at https://aistudio.google.com/billing).";
  }
  if (lower.includes("api key") || lower.includes("api_key_invalid") || lower.includes("permission_denied")) {
    return "The Gemini API key was rejected. Check GEMINI_API_KEY in your .env file.";
  }
  if (lower.includes("429") || lower.includes("quota") || lower.includes("resource_exhausted")) {
    return "Gemini rate limit or quota reached. Wait a moment and try again.";
  }
  if (lower.includes("503") || lower.includes("unavailable") || lower.includes("overloaded")) {
    return "Gemini is overloaded right now. Please try again in a few seconds.";
  }
  if (lower.includes("safety") || lower.includes("blocked")) {
    return "That request was blocked by Gemini's safety filters. Try rephrasing it.";
  }
  if (lower.includes("multiple tools") || lower.includes("tool use with a response mime type")) {
    return "That tool combination isn't supported by the model. Turn off one tool and retry.";
  }
  if (lower.includes("not found") || lower.includes("not_found") || lower.includes("is not supported")) {
    return "The requested Gemini model was not found or is unsupported with your key. You can set GEMINI_MODEL in .env to a supported model (e.g. gemini-2.5-flash or gemini-2.0-flash).";
  }
  return raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
}

/* ------------------------------------------------------------------ */
/* Tiny in-memory rate limiter (30 requests / minute / IP)             */
/* ------------------------------------------------------------------ */

const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 30;
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    return res.status(429).json({ error: "Too many requests. Please slow down for a minute." });
  }
  arr.push(now);
  hits.set(req.ip, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  const { hasKey, model } = getEnvConfig();
  res.json({ ok: true, model, keyConfigured: hasKey });
});

app.post("/api/chat", rateLimit, async (req, res) => {
  const { apiKey, hasKey, model } = getEnvConfig();
  if (!hasKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing. Open the .env file in your project, add your key, and try again.",
    });
  }

  const ai = new GoogleGenAI({ apiKey });

  const body = req.body || {};
  const persona = PERSONAS[body.persona] ? body.persona : "humanoid";
  const jsonMode = body.json === true;
  const webSearch = body.webSearch === true;
  const codeExec = body.codeExec === true;

  if (!Array.isArray(body.messages)) {
    return res.status(400).json({ error: "messages must be an array." });
  }
  const contents = buildContents(body.messages);
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "The conversation must end with a user message." });
  }

  // Gemini 2.5 rules:
  //  - JSON mime type can't be combined with tools.
  //  - Google Search grounding and code execution can't be combined in one request.
  // So: JSON mode > Web Search > Code Execution.
  const config = {
    systemInstruction: buildSystemInstruction(persona, jsonMode),
    temperature: PERSONAS[persona].temperature,
  };
  if (jsonMode) config.responseMimeType = "application/json";
  else if (webSearch) config.tools = [{ googleSearch: {} }];
  else if (codeExec) config.tools = [{ codeExecution: {} }];

  const controller = new AbortController();
  config.abortSignal = controller.signal;

  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  let headersSent = false;
  const startSSE = () => {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  };
  const send = (obj) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const candidateModels = [model, "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.8-flash"].filter(
      (m, i, arr) => m && arr.indexOf(m) === i
    );

    let stream = null;
    let lastErr = null;
    for (const m of candidateModels) {
      if (clientGone) break;
      try {
        stream = await ai.models.generateContentStream({ model: m, contents, config });
        break;
      } catch (err) {
        lastErr = err;
        const lower = String(err?.message || err).toLowerCase();
        if (lower.includes("503") || lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("not found")) {
          console.warn(`[/api/chat] Model ${m} unavailable, trying fallback...`);
          continue;
        }
        throw err;
      }
    }
    if (!stream) throw lastErr;
    startSSE();

    let producedText = false;
    let finishReason = null;
    let grounding = null;

    for await (const chunk of stream) {
      if (clientGone) break;
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      if (cand?.groundingMetadata) grounding = cand.groundingMetadata;

      for (const part of cand?.content?.parts || []) {
        if (part.thought) continue;
        let t = "";
        if (part.text) {
          t = part.text;
        } else if (part.executableCode) {
          const lang = String(part.executableCode.language || "python").toLowerCase();
          t = `\n\n\`\`\`${lang === "language_unspecified" ? "python" : lang}\n${part.executableCode.code}\n\`\`\`\n\n`;
        } else if (part.codeExecutionResult) {
          const out = String(part.codeExecutionResult.output || "").trim();
          t = `\n**Output**\n\n\`\`\`\n${out || "(no output)"}\n\`\`\`\n\n`;
        }
        if (t) {
          producedText = true;
          send({ type: "text", text: t });
        }
      }
    }

    if (!clientGone) {
      if (grounding?.groundingChunks?.length) {
        const seen = new Set();
        const sources = [];
        for (const g of grounding.groundingChunks) {
          const uri = g.web?.uri;
          if (!uri || seen.has(uri)) continue;
          seen.add(uri);
          sources.push({ uri, title: g.web?.title || uri });
        }
        if (sources.length) send({ type: "sources", sources });
      }
      if (!producedText) {
        send({
          type: "error",
          message: `Gemini returned an empty response${finishReason ? ` (reason: ${finishReason})` : ""}. Try rephrasing.`,
        });
      }
      send({ type: "done" });
      res.end();
    }
  } catch (err) {
    if (clientGone) return;
    const message = friendlyError(err);
    console.error("[/api/chat]", err?.message || err);
    if (!headersSent) {
      return res.status(500).json({ error: message });
    }
    send({ type: "error", message });
    res.end();
  }
});

// JSON error handler (bad JSON, payload too large, etc.)
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Attachments are too large. Keep files under about 10 MB each." });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

app.listen(PORT, () => {
  const { hasKey, model } = getEnvConfig();
  console.log(`\n  ZTI is running →  http://localhost:${PORT}`);
  console.log(`  Model: ${model}`);
  if (!hasKey) {
    console.log("  ⚠  GEMINI_API_KEY is not set. Add your Gemini API key to .env\n");
  } else {
    console.log("  Gemini API key loaded from .env\n");
  }
});
