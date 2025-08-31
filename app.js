// app.js - Fixed Luna Discord Bot (Neuro-sama style basics + memory + Gemini + GitHub AI)
// ESM module version — works with "type": "module" in package.json

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
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || 'models/gemini-2.5-chat';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''; // optional

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON) {
  console.error('Missing required environment variables: DISCORD_TOKEN and GEMINI_CREDENTIALS_JSON are required.');
  process.exit(1);
}

/* ---------------- Keep-alive / Uptime route ---------------- */
const keepAliveApp = express();
const PORT = Number(process.env.PORT || 10000);
keepAliveApp.get('/', (req, res) => {
  res.send('Luna Discord Bot is running');
});
keepAliveApp.listen(PORT, () => {
  console.log(`[KeepAlive] Server running on port ${PORT}`);
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
    return rows.reverse().map(r => `User (mood:${r.mood}, personality:${r.personality}): ${r.content}\nLuna: ${r.response}`).join('\n');
  } catch (e) {
    console.error('fetchRecentMemories error:', e);
    return '';
  }
}

/* ---------------- Google Auth (Gemini) ---------------- */
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
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
  if (!token) throw new Error('Failed to get token from GoogleAuth client');
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000; // conservative expiry
  return cachedToken;
}

/* ---------------- Gemini query helper ---------------- */
async function queryGemini(prompt, opts = {}) {
  try {
    const token = await getAccessToken();
    const model = GEMINI_MODEL_ENV;
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateMessage`;

    const body = {
      messages: [{ author: "user", content: [{ type: "text", text: prompt }] }],
      temperature: opts.temperature ?? 0.8,
      maxOutputTokens: opts.maxOutputTokens ?? 400
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      throw new Error(`Gemini failed: ${txt}`);
    }

    const data = await res.json();
    // Try common response locations
    const candidate = data?.candidates?.[0]?.content?.[0]?.text || data?.output?.[0]?.content?.[0]?.text;
    if (candidate) return candidate;
    // fallback: stringify small
    return JSON.stringify(data).slice(0, 2000);
  } catch (e) {
    console.warn('Gemini failed, will attempt GitHub AI fallback:', e.message);
    return queryGitHubAI(prompt);
  }
}

/* ---------------- GitHub AI fallback (OpenAI client to GitHub models) ---------------- */
const githubClient = new OpenAI({ baseURL: 'https://models.github.ai/inference', apiKey: GITHUB_TOKEN });

async function queryGitHubAI(prompt) {
  if (!GITHUB_TOKEN) {
    console.warn('No GITHUB_TOKEN provided — skipping GitHub AI fallback.');
    return "Sorry, I can't think right now (no fallback available).";
  }
  try {
    const response = await githubClient.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'You are Luna, a friendly, witty AI who remembers user personality and mood.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 400
    });
    return response.choices?.[0]?.message?.content ?? "I couldn't generate a reply.";
  } catch (err) {
    console.error('GitHub AI error:', err);
    return 'Sorry, I cannot generate a reply right now (fallback failed).';
  }
}

/* ---------------- Discord client (fixed intents) ---------------- */
/*
  Important: remove invalid intents. Valid ones used below:
  - Guilds
  - GuildMessages
  - MessageContent (for reading message text)
*/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

/* ---------------- Mention detection helpers ---------------- */
function messageMentionsBot(message) {
  // direct mention like <@id>
  if (message.mentions && message.mentions.users && message.mentions.users.has(client.user.id)) return true;

  // call by name (case-insensitive)
  const content = (message.content || '').toLowerCase();
  if (content.includes('luna')) return true; // matches the name anywhere

  // check for nickname mention spelled exactly as displayName
  const nick = message.member?.nickname?.toLowerCase();
  if (nick && content.includes(nick)) return true;

  return false;
}

/* ---------------- Cooldown ---------------- */
const COOLDOWN = new Map();
const USER_COOLDOWN_MS = Number(process.env.USER_COOLDOWN_MS || 7000); // default 7s

/* ---------------- Message handler ---------------- */
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return; // ignore bots

    // Do we need to respond?
    if (!messageMentionsBot(message)) return;

    // Cooldown per user
    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) return;
    COOLDOWN.set(message.author.id, Date.now());

    // Build prompt/context
    const displayName = message.member?.nickname ?? message.author.username;
    const recent = await fetchRecentMemories(message.author.id, 6);

    // Compose system + context; keep concise to avoid token issues
    const prompt = `You are Luna — a playful, witty AI who likes strawberries and space.
User: ${displayName}
Recent memory:
${recent || '(no recent memory)'}
New message: ${message.content}

Reply warmly and helpfully, reflect on previous memory if relevant, and keep responses short (1-6 sentences).`;

    // Query Gemini (primary)
    const reply = await queryGemini(prompt);

    // Basic mood & personality heuristics (small and fast)
    let mood = 'neutral';
    let personality = 'neutral';
    const lcReply = reply.toLowerCase();
    if (lcReply.includes('happy') || lcReply.includes('joy') || lcReply.includes('glad')) mood = 'happy';
    if (lcReply.includes('sad') || lcReply.includes('sorry') || lcReply.includes('unfortunately')) mood = 'sad';
    if (lcReply.includes('angry') || lcReply.includes('frustrat')) mood = 'angry';
    if (lcReply.includes('playful') || lcReply.includes('joke') || lcReply.includes('hehe')) personality = 'playful';
    if (lcReply.includes('serious') || lcReply.includes('formal')) personality = 'serious';

    // Store memory
    await storeMemory(message.author.id, displayName, message.content, reply, mood, personality);

    // Reply
    await message.reply(reply);
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

/* ---------------- Login ---------------- */
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
