// app.js
// - Gemini primary (Google service account auth)
// - GitHub AI fallback (via OpenAI SDK to GitHub models)
// - SQLite memory (per-user memories, mood & personality fields)
// - Keep-alive HTTP endpoint (for uptime monitors)
// - Mention detection, dedupe guard, cooldowns
// Set env vars:
// DISCORD_TOKEN, GEMINI_CREDENTIALS_JSON (stringified service account JSON), optionally GITHUB_TOKEN, PORT

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import pkg from 'google-auth-library';
import OpenAI from 'openai';
import express from 'express';

const { GoogleAuth } = pkg;

/* ---------------- Environment ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-chat';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const PORT = Number(process.env.PORT || 10000);
const USER_COOLDOWN_MS = Number(process.env.USER_COOLDOWN_MS || 7000); // default 7s
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 60_000); // 60s

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}
if (!GEMINI_CREDENTIALS_JSON) {
  console.error('Missing GEMINI_CREDENTIALS_JSON environment variable.');
  process.exit(1);
}

/* ---------------- Keep-alive server ---------------- */
const keepAliveApp = express();
keepAliveApp.get('/', (req, res) => {
  console.log(`[KeepAlive] ping ${new Date().toISOString()} from ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`);
  res.status(200).send('Luna Discord Bot is running');
});
keepAliveApp.get('/health', (req, res) => {
  res.status(200).json({ ok: true, pid: process.pid, time: new Date().toISOString() });
});
keepAliveApp.listen(PORT, () => {
  console.log(`[KeepAlive] Server listening on port ${PORT}`);
});

/* ---------------- SQLite memory ---------------- */
let db;
(async () => {
  db = await open({ filename: './memory.db', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      user_name TEXT,
      content TEXT,
      response TEXT,
      mood TEXT,
      personality TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Connected to SQLite database');
})();

async function storeMemory(userId, userName, content, response, mood = 'neutral', personality = 'neutral') {
  try {
    await db.run(
      `INSERT INTO memories (user_id, user_name, content, response, mood, personality) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, userName, content, response, mood, personality]
    );
  } catch (e) {
    console.error('storeMemory error:', e);
  }
}

async function fetchRecentMemories(userId, limit = 6) {
  try {
    const rows = await db.all(
      `SELECT content, response, mood, personality FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.reverse().map(r =>
      `User (mood:${r.mood}, personality:${r.personality}): ${r.content}\nLuna: ${r.response}`
    ).join('\n');
  } catch (e) {
    console.error('fetchRecentMemories error:', e);
    return '';
  }
}

/* ---------------- Google Auth (Gemini) ---------------- */
let credentials;
try {
  credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
} catch (e) {
  console.error('Failed to parse GEMINI_CREDENTIALS_JSON:', e);
  process.exit(1);
}

const googleAuth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/generative-language']
});

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error('Failed to obtain access token from Google client');
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 minutes
  return cachedToken;
}

/* ---------------- Gemini API call ---------------- */
async function queryGemini(prompt, opts = {}) {
  try {
    const token = await getAccessToken();
    const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateMessage`;

    const body = {
      messages: [{ author: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: opts.temperature ?? 0.8,
      maxOutputTokens: opts.maxOutputTokens ?? 400
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': credentials?.project_id || ''
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = await res.json();
    // Extract sensible text paths
    const candidate = data?.candidates?.[0]?.content?.[0]?.text
      || data?.candidates?.[0]?.content?.map(c => c.text).join('\n')
      || data?.output?.[0]?.content?.[0]?.text
      || data?.generatedText
      || null;

    if (candidate) return candidate;
    return JSON.stringify(data).slice(0, 2000);
  } catch (e) {
    console.warn('Gemini failed:', e?.message || e);
    // fallback to GitHub AI
    return queryGitHubAI(prompt);
  }
}

/* ---------------- GitHub AI fallback (OpenAI client to GitHub models) ---------------- */
const githubClient = new OpenAI({ apiKey: GITHUB_TOKEN, baseURL: 'https://models.github.ai/inference' });

async function queryGitHubAI(prompt) {
  if (!GITHUB_TOKEN) {
    console.warn('No GITHUB_TOKEN set; GitHub AI fallback unavailable.');
    return "Sorry, I can't think right now (no fallback available).";
  }
  try {
    const resp = await githubClient.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'You are Luna — a playful, witty AI who remembers user personality and mood.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 400
    });
    return resp.choices?.[0]?.message?.content ?? "I couldn't generate a reply.";
  } catch (err) {
    console.error('GitHub AI error:', err);
    return 'Sorry, I cannot generate a reply right now (fallback failed).';
  }
}

/* ---------------- Discord client ---------------- */
/* Use only valid intents for discord.js v14+ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Discord bot ready as ${client.user.tag} (pid ${process.pid})`);
});

/* ---------------- Mention detection helper ---------------- */
function messageMentionsBot(message) {
  if (!message || !message.content) return false;

  // direct mention (<@id> or <@!id>)
  if (message.mentions?.users?.has && message.mentions.users.has(client.user.id)) return true;

  // nickname mention spelled exactly (case-insensitive)
  const nick = message.member?.nickname?.toLowerCase();
  if (nick && message.content.toLowerCase().includes(nick)) return true;

  // name calling "luna" anywhere (case-insensitive) — adjust if too noisy
  if (message.content.toLowerCase().includes('luna')) return true;

  return false;
}

/* ---------------- Dedupe + cooldown ---------------- */
const handledMessages = new Set();
function markHandled(messageId) {
  handledMessages.add(messageId);
  setTimeout(() => handledMessages.delete(messageId), DEDUPE_TTL_MS);
}

const COOLDOWN = new Map();

/* ---------------- Message handler ---------------- */
client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.content) return;
    if (message.author?.bot) return;

    // dedupe within this process
    if (handledMessages.has(message.id)) {
      // already handled recently in this process
      return;
    }

    // check whether to respond
    if (!messageMentionsBot(message)) return;

    // user cooldown
    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) {
      return;
    }
    COOLDOWN.set(message.author.id, Date.now());

    // mark handled immediately (prevents duplicate replies in same process)
    markHandled(message.id);

    const displayName = message.member?.nickname ?? message.author.username;
    const recent = await fetchRecentMemories(message.author.id, 6);

    const shortRecent = recent ? `Recent memory:\n${recent}\n\n` : '';

    const prompt = `You are Luna, a playful, witty AI who loves strawberries and space.
${shortRecent}User: ${displayName}
Message: ${message.content}

Respond concisely (1-6 sentences), friendly and helpful. If appropriate, recall prior memory from the Recent memory section.`;

    // Query Gemini (primary), fallback handled inside function
    const reply = await queryGemini(prompt);

    // quick mood & personality heuristics (simple, can be improved)
    let mood = 'neutral';
    let personality = 'neutral';
    const lc = (reply || '').toLowerCase();
    if (lc.match(/\b(happy|glad|joy|yay|excited)\b/)) mood = 'happy';
    if (lc.match(/\b(sad|sorry|unfortunate|sorrow)\b/)) mood = 'sad';
    if (lc.match(/\b(angry|annoyed|frustrat)\b/)) mood = 'angry';
    if (lc.match(/\b(joke|joking|playful|hehe|lol)\b/)) personality = 'playful';
    if (lc.match(/\b(serious|formal|professional)\b/)) personality = 'serious';

    await storeMemory(message.author.id, displayName, message.content, reply, mood, personality);

    console.log(`[REPLY] pid ${process.pid} -> ${message.author.tag} msg:${message.id}`);
    await message.reply(reply).catch(err => {
      console.error('Failed to send reply:', err);
    });
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

/* ---------------- Login ---------------- */
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
