// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import pkg from 'google-auth-library';
const { GoogleAuth } = pkg;

/* ---------------- env ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON; // stringified service account JSON
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || ''; // optional override, e.g. "models/gemini-2.5-flash"

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN env var');
  process.exit(1);
}
if (!GEMINI_CREDENTIALS_JSON) {
  console.error('Missing GEMINI_CREDENTIALS_JSON env var');
  process.exit(1);
}

/* ---------------- Express (Render) ---------------- */
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Luna Discord Bot is running'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

/* ---------------- SQLite memory ---------------- */
let db;
(async () => {
  db = await open({
    filename: './memory.db',
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      user_name TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Connected to SQLite database');
})();

async function storeMemory(userId, userName, content) {
  try {
    await db.run(
      `INSERT INTO memories (user_id,user_name,content) VALUES(?,?,?)`,
      [userId, userName, content]
    );
  } catch (e) {
    console.error('storeMemory error:', e);
  }
}

async function fetchRecentMemories(userId, limit = 5) {
  try {
    const rows = await db.all(
      `SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.map(r => r.content).reverse();
  } catch (e) {
    console.error('fetchRecentMemories error:', e);
    return [];
  }
}

/* ---------------- Google Auth (Gemini) ---------------- */
const credentials = (() => {
  try {
    return JSON.parse(GEMINI_CREDENTIALS_JSON);
  } catch (e) {
    console.error('Failed to parse GEMINI_CREDENTIALS_JSON:', e);
    process.exit(1);
  }
})();

const googleAuth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/generative-language']
});

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60 * 1000) {
    return cachedToken;
  }

  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

  if (!token) throw new Error('Failed to obtain access token from Google auth client');

  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

/* ---------------- Model discovery ---------------- */
let cachedModelName = null; // e.g. "models/gemini-2.5-flash"

async function listAvailableModels() {
  try {
    const token = await getAccessToken();
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': credentials.project_id || ''
      }
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('List Models API error:', res.status, txt);
      throw new Error(`List Models API error: ${res.status}`);
    }

    const data = await res.json();
    return Array.isArray(data?.models) ? data.models : [];
  } catch (e) {
    console.error('listAvailableModels error:', e);
    return [];
  }
}

function pickPreferredModel(models, envModel) {
  if (!models || models.length === 0) return null;
  if (envModel) {
    const normalized = envModel.startsWith('models/') ? envModel : `models/${envModel}`;
    const match = models.find(m => m.name === normalized || m.name.endsWith(`/${normalized.split('/').pop()}`) || m.name.includes(normalized.split('/').pop()));
    if (match) return match.name;
  }

  const preferredKeys = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0',
    'gemini-2.5'
  ];

  for (const key of preferredKeys) {
    const found = models.find(m => m.name.includes(key));
    if (found) return found.name;
  }

  const geminiModel = models.find(m => m.name.toLowerCase().includes('gemini'));
  if (geminiModel) return geminiModel.name;
  return models[0].name;
}

async function ensureModel() {
  if (cachedModelName) return cachedModelName;

  const models = await listAvailableModels();
  if (!models.length) {
    console.warn('No models returned from List Models; will attempt to use env GEMINI_MODEL or default model path.');
    if (GEMINI_MODEL_ENV) {
      cachedModelName = GEMINI_MODEL_ENV.startsWith('models/') ? GEMINI_MODEL_ENV : `models/${GEMINI_MODEL_ENV}`;
      return cachedModelName;
    }
    cachedModelName = 'models/gemini-2.5-flash';
    return cachedModelName;
  }

  const chosen = pickPreferredModel(models, GEMINI_MODEL_ENV);
  cachedModelName = chosen;
  console.log('Selected Gemini model:', cachedModelName);
  return cachedModelName;
}

/* ---------------- Quota/backoff helpers ---------------- */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryDelay(detail) {
  try {
    if (!detail) return null;
    // detail may be an object containing retryDelay like "49s" or an ISO string PT...S
    if (typeof detail.retryDelay === 'string') {
      const rd = detail.retryDelay;
      const sMatch = /^(\d+(?:\.\d+)?)s$/.exec(rd);
      if (sMatch) return Math.ceil(parseFloat(sMatch[1]) * 1000);
      const iso = /^PT(?:(\d+)M)?(?:(\d+)S)?$/i.exec(rd);
      if (iso) {
        const mins = parseInt(iso[1] || '0', 10);
        const secs = parseInt(iso[2] || '0', 10);
        return (mins * 60 + secs) * 1000;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

const FALLBACK_MODEL_CANDIDATES = [
  'models/gemini-2.5-flash',
  'models/gemini-2.0-flash',
  'models/gemini-2.5',
  'models/gemini-2.0'
];

async function tryFallbackModel() {
  const models = await listAvailableModels();
  const names = models.map(m => m.name);
  for (const cand of FALLBACK_MODEL_CANDIDATES) {
    const candKey = cand.split('/').pop();
    const found = names.find(n => n === cand || n.endsWith(`/${candKey}`) || n.includes(candKey));
    if (found) return found;
  }
  if (names.length) return names[0];
  if (GEMINI_MODEL_ENV) return GEMINI_MODEL_ENV.startsWith('models/') ? GEMINI_MODEL_ENV : `models/${GEMINI_MODEL_ENV}`;
  return 'models/gemini-2.5-flash';
}

/* ---------------- Gemini Query (generateContent) with backoff & fallback ---------------- */
async function parseGeminiResponse(data) {
  try {
    const cand = data?.candidates?.[0] || data?.response?.candidates?.[0];
    if (cand) {
      const content = cand?.content || cand?.output || cand;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        if (typeof content[0] === 'string') return content.join('\n');
        if (content[0]?.text) return content.map(c => c.text).join('\n');
      }
      if (content?.parts?.[0]?.text) return content.parts.map(p => p.text).join('\n');
    }
    if (data?.generatedText) return data.generatedText;
    if (data?.output_text) return data.output_text;
    return JSON.stringify(data).slice(0, 2000);
  } catch (e) {
    console.error('parseGeminiResponse error:', e);
    return 'Sorry, I could not parse the AI response.';
  }
}

async function queryGemini(prompt, options = {}) {
  const MAX_ATTEMPTS = 5;
  let attempt = 0;
  let lastError = null;
  let modelName = await ensureModel();

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const token = await getAccessToken();
      const projectId = credentials.project_id || '';
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;

      const body = {
        contents: [
          { parts: [{ text: prompt }] }
        ]
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': projectId
        },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const data = await res.json();
        return parseGeminiResponse(data);
      }

      const txt = await res.text();
      let jsonBody = null;
      try { jsonBody = JSON.parse(txt); } catch (e) { /* ignore */ }

      // Handle 429 quota / rate-limit
      if (res.status === 429) {
        console.warn(`Gemini 429 on model ${modelName} (attempt ${attempt}): ${txt}`);

        // parse retryDelay
        let waitMs = null;
        if (jsonBody?.error?.details && Array.isArray(jsonBody.error.details)) {
          for (const d of jsonBody.error.details) {
            const ms = parseRetryDelay(d);
            if (ms) { waitMs = ms; break; }
          }
        }

        // fallback to Retry-After header
        const hdr = res.headers.get ? res.headers.get('retry-after') : null;
        if (!waitMs && hdr) {
          const n = Number(hdr);
          if (!Number.isNaN(n)) waitMs = Math.ceil(n * 1000);
        }

        const errMsg = jsonBody?.error?.message || txt || '';
        if (errMsg.toLowerCase().includes("doesn't have a free quota") || errMsg.toLowerCase().includes('does not have a free quota')) {
          console.warn('Model appears to be preview/paid-only — attempting fallback model.');
          const newModel = await tryFallbackModel();
          if (newModel && newModel !== modelName) {
            console.log(`Switching model ${modelName} -> ${newModel}`);
            modelName = newModel;
            cachedModelName = modelName;
            await sleep(1000 + Math.random() * 500);
            continue; // retry immediately with new model
          }
        }

        if (!waitMs) {
          const base = Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          waitMs = Math.min(60_000, base * 1000 + jitter);
        }

        console.log(`Waiting ${Math.round(waitMs/1000)}s before retrying (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      // 404: model not found -> refresh models once
      if (res.status === 404) {
        console.warn(`Model ${modelName} not found (404). Will attempt to refresh models and retry once.`);
        cachedModelName = null;
        const refreshed = await ensureModel();
        if (refreshed !== modelName) {
          modelName = refreshed;
          continue;
        }
      }

      // other errors -> throw to outer catch
      throw new Error(`Gemini API error: ${res.status} ${txt}`);
    } catch (e) {
      lastError = e;
      console.error(`queryGemini attempt ${attempt} failed:`, e);
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = Math.min(60_000, Math.pow(2, attempt) * 1000 + Math.random() * 500);
        await sleep(backoffMs);
        continue;
      }
    }
  }

  console.error('All queryGemini attempts failed:', lastError);
  return 'Sorry, I cannot reach the AI right now (quota or model issue).';
}

/* ---------------- Discord bot ---------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
});

const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25;
const USER_COOLDOWN_MS = 15_000;

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    const isMention = message.mentions.has(client.user);
    const isAutonomous = !isMention && Math.random() < RESPONSE_PROBABILITY;
    if (!isMention && !isAutonomous) return;

    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) return;
    COOLDOWN.set(message.author.id, Date.now());

    const mems = await fetchRecentMemories(message.author.id);
    const memoryText = mems.map(m => `Memory: ${m}`).join('\n');
    const fullPrompt = `You are "Luna", a playful, witty AI who loves strawberries and space.\n${memoryText}\nUser: ${message.content}`;

    const reply = await queryGemini(fullPrompt);
    await storeMemory(message.author.id, message.author.username, message.content);
    await storeMemory(message.author.id, message.author.username, `Luna: ${reply}`);
    await message.reply(reply);
  } catch (e) {
    console.error('messageCreate handler error:', e);
  }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
