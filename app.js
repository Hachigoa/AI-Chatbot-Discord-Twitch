// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import pkg from 'google-auth-library';
import OpenRouter from 'openrouter'; // <- puter.js / OpenRouter SDK
const { GoogleAuth } = pkg;

/* ---------------- env ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // Puter/OpenRouter key

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON) {
  console.error('Missing environment variables');
  process.exit(1);
}

/* ---------------- Express ---------------- */
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Luna Discord Bot is running'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Connected to SQLite database');
})();

async function storeMemory(userId, userName, content) {
  try { await db.run(`INSERT INTO memories (user_id,user_name,content) VALUES(?,?,?)`, [userId, userName, content]); }
  catch(e) { console.error('storeMemory error:', e); }
}

async function fetchRecentMemories(userId, limit = 5) {
  try {
    const rows = await db.all(`SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
    return rows.map(r => r.content).reverse();
  } catch(e) { console.error('fetchRecentMemories error:', e); return []; }
}

/* ---------------- Google Auth (Gemini) ---------------- */
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
const googleAuth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/generative-language'] });

let cachedToken = null;
let tokenExpiresAt = 0;
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error('Failed to get token');
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

/* ---------------- Gemini + Puter Query ---------------- */
const openRouterAI = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

async function queryGeminiOrPuter(prompt) {
  try {
    // Try Gemini first
    const token = await getAccessToken();
    const model = GEMINI_MODEL_ENV || 'models/gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
    const body = { prompt: { text: prompt }, temperature: 0.8, maxOutputTokens: 300, candidateCount: 1 };

    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

    const data = await res.json();
    const candidate = data?.candidates?.[0] || data?.response?.candidates?.[0];
    if (!candidate) throw new Error('No candidate from Gemini');

    if (typeof candidate === 'string') return candidate;
    if (candidate?.content) return candidate.content;
    if (Array.isArray(candidate?.content)) return candidate.content.map(c => c.text || c).join('\n');
    return JSON.stringify(candidate).slice(0, 2000);

  } catch (gemError) {
    console.warn('Gemini failed, falling back to Puter/OpenRouter:', gemError.message);

    // Fallback to Puter/OpenRouter
    if (!OPENROUTER_API_KEY) return 'Sorry, AI is unavailable right now.';
    try {
      const response = await openRouterAI.chat.completions.create({
        model: 'gpt-4o-mini', // Puter default model
        messages: [{ role: 'user', content: prompt }]
      });
      return response.choices[0].message.content;
    } catch (putError) {
      console.error('Puter fallback failed:', putError);
      return 'Sorry, AI is unavailable right now.';
    }
  }
}

/* ---------------- Discord Bot ---------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25;
const USER_COOLDOWN_MS = 15000;

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) return;
    COOLDOWN.set(message.author.id, Date.now());

    if (Math.random() > RESPONSE_PROBABILITY) return; // simple probability

    const displayName = message.member?.nickname || message.author.username;
    const mems = await fetchRecentMemories(message.author.id);
    const memoryText = mems.map(m => `Memory: ${m}`).join('\n');
    const fullPrompt = `You are "Luna", a playful, witty AI who loves strawberries and space.\nUser (${displayName}): ${message.content}\n${memoryText}`;

    const reply = await queryGeminiOrPuter(fullPrompt);
    await storeMemory(message.author.id, displayName, message.content);
    await storeMemory(message.author.id, displayName, `Luna: ${reply}`);

    await message.reply(reply);
  } catch(e) { console.error('messageCreate handler error:', e); }
});

client.login(DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
