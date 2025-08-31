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
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || ''; // optional: e.g. "models/gemini-2.5-pro"

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

// Use the generative-language scope
const googleAuth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/generative-language']
});

let cachedToken = null;
let tokenExpiresAt = 0;

// get a valid access token, with simple caching
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60 * 1000) { // refresh 60s before expiry
    return cachedToken;
  }

  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

  if (!token) throw new Error('Failed to obtain access token from Google auth client');

  // conservative expiry
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

/* ---------------- Model discovery ---------------- */

let cachedModelName = null; // full model resource name, e.g. "models/gemini-2.5-pro"

async function listAvailableModels() {
  try {
    const token = await getAccessToken();
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': credentials.project_id || '' // associate request with project
      }
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('List Models API error:', res.status, txt);
      throw new Error(`List Models API error: ${res.status}`);
    }

    const data = await res.json();
    // Expect data.models to be an array of model objects with .name
    return Array.isArray(data?.models) ? data.models : [];
  } catch (e) {
    console.error('listAvailableModels error:', e);
    return [];
  }
}

function pickPreferredModel(models, envModel) {
  // models: array of { name: "models/gemini-2.5-pro", ... }
  if (!models || models.length === 0) return null;

  // 1) If user provided an env var model, prefer it if present
  if (envModel) {
    const match = models.find(m => m.name === envModel || m.name.endsWith(`/${envModel}`) || m.name.includes(envModel));
    if (match) return match.name;
  }

  // 2) Preferred candidate order (common stable models)
  const preferredKeys = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5',
    'gemini-2.0',
    'gemini-pro'
  ];

  for (const key of preferredKeys) {
    const found = models.find(m => m.name.includes(key));
    if (found) return found.name;
  }

  // 3) fallback to first model that looks like a 'gemini' model
  const geminiModel = models.find(m => m.name.toLowerCase().includes('gemini'));
  if (geminiModel) return geminiModel.name;

  // 4) final fallback: first model in list
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
    // fallback - this may produce a 404 if invalid
    cachedModelName = 'models/gemini-2.5-pro';
    return cachedModelName;
  }

  const chosen = pickPreferredModel(models, GEMINI_MODEL_ENV);
  cachedModelName = chosen;
  console.log('Selected Gemini model:', cachedModelName);
  return cachedModelName;
}

/* ---------------- Gemini Query (generateContent) ---------------- */
async function queryGemini(prompt) {
  try {
    const token = await getAccessToken();
    const modelName = await ensureModel(); // e.g. "models/gemini-2.5-pro"
    const projectId = credentials.project_id || '';
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;

    const body = {
      contents: [
        {
          parts: [{ text: prompt }]
        }
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

    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      // If we get 404 for the chosen model, try refreshing model list once and retry
      if (res.status === 404) {
        console.warn('Model not found. Refreshing models and retrying once...');
        cachedModelName = null;
        const newModel = await ensureModel();
        if (newModel !== modelName) {
          // retry with new model
          const retryUrl = `https://generativelanguage.googleapis.com/v1beta/${newModel}:generateContent`;
          const retry = await fetch(retryUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-goog-user-project': projectId
            },
            body: JSON.stringify(body)
          });
          if (!retry.ok) {
            const rtxt = await retry.text();
            console.error('Retry Gemini API error:', retry.status, rtxt);
            throw new Error(`Gemini API error after retry: ${retry.status}`);
          }
          const retryData = await retry.json();
          return parseGeminiResponse(retryData);
        }
      }
      throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = await res.json();
    return parseGeminiResponse(data);
  } catch (e) {
    console.error('queryGemini error:', e);
    return 'Sorry, I cannot reach the AI right now.';
  }
}

function parseGeminiResponse(data) {
  // Try the common response shapes defensively
  try {
    // new format: data.candidates[0].content.parts[0].text
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

    // legacy / alternate: data.generatedText or data.output_text
    if (data?.generatedText) return data.generatedText;
    if (data?.output_text) return data.output_text;

    // last resort: stringify
    return JSON.stringify(data).slice(0, 2000); // shorten long JSON
  } catch (e) {
    console.error('parseGeminiResponse error:', e);
    return 'Sorry, I could not parse the AI response.';
  }
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
