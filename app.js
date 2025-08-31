// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';

/* ---------------- Environment ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
const GITHUB_AI_TOKEN = process.env.GITHUB_AI_TOKEN;
const PORT = process.env.PORT || 10000;

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON || !GITHUB_AI_TOKEN) {
  console.error('Missing environment variables');
  process.exit(1);
}

/* ---------------- Express ---------------- */
const app = express();
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

/* ---------------- Gemini API ---------------- */
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
const googleAuth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/generative-language'] });

let cachedToken = null;
let tokenExpiresAt = 0;
async function getGeminiAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error('Failed to get Gemini access token');
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000; // cache 55 min
  return cachedToken;
}

async function queryGemini(prompt) {
  try {
    const token = await getGeminiAccessToken();
    const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateText`;
    const body = {
      text: prompt,
      temperature: 0.8,
      maxOutputTokens: 300
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
    return data?.candidates?.[0]?.content || 'Gemini could not generate a response.';
  } catch(e) {
    console.warn('Gemini failed:', e.message);
    throw e; // Let Discord bot handle fallback
  }
}

/* ---------------- GitHub AI ---------------- */
const githubClient = new OpenAI({ apiKey: GITHUB_AI_TOKEN, baseURL: 'https://api.github.com' });

async function queryGitHubAI(prompt) {
  try {
    const response = await githubClient.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 300
    });
    return response.choices?.[0]?.message?.content || 'GitHub AI could not generate a response.';
  } catch(e) {
    console.error('GitHub AI error:', e.message);
    throw e;
  }
}

/* ---------------- Discord Bot ---------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('clientReady', () => console.log(`Discord bot ready as ${client.user.tag}`));

const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25;
const USER_COOLDOWN_MS = 15000;

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) return;
    COOLDOWN.set(message.author.id, Date.now());

    if (Math.random() > RESPONSE_PROBABILITY) return;

    const displayName = message.member?.nickname || message.author.username;
    const mems = await fetchRecentMemories(message.author.id);
    const memoryText = mems.map(m => `Memory: ${m}`).join('\n');
    const fullPrompt = `You are "Luna", a playful AI.\nUser (${displayName}): ${message.content}\n${memoryText}`;

    // Try Gemini first, fallback to GitHub AI
    let reply;
    try { reply = await queryGemini(fullPrompt); }
    catch { reply = await queryGitHubAI(fullPrompt); }

    await storeMemory(message.author.id, displayName, message.content);
    await storeMemory(message.author.id, displayName, `Luna: ${reply}`);

    await message.reply(reply);
  } catch(e) { console.error('messageCreate handler error:', e); }
});

client.login(DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err); process.exit(1); })
