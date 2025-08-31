import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import OpenAI from 'openai'; // GitHub AI uses OpenAI package
import pkg from 'google-auth-library';
const { GoogleAuth } = pkg;

/* ---------------- env ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || '';
const GITHUB_AI_TOKEN = process.env.GITHUB_AI_TOKEN; // personal access token

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON || !GITHUB_AI_TOKEN) {
  console.error('Missing environment variables');
  process.exit(1);
}

/* ---------------- Express ---------------- */
const app = express();
const PORT = process.env.PORT || 10000;

// Status route: check if AI services are reachable
app.get('/', async (req, res) => {
  try {
    // simple Gemini test
    const token = await getGeminiToken();
    if (!token) throw new Error('Gemini not ready');
    res.send('Luna Discord Bot is running ✅ AI services connected');
  } catch (e) {
    res.send('Luna Discord Bot is running ⚠️ AI services not ready');
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

/* ---------------- SQLite ---------------- */
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

/* ---------------- Gemini ---------------- */
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
const googleAuth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/generative-language'] });
let cachedToken = null;
let tokenExpiresAt = 0;

async function getGeminiToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function queryGemini(prompt) {
  try {
    const token = await getGeminiToken();
    const model = GEMINI_MODEL_ENV || 'models/gemini-2.5-chat';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:chat`;

    const body = {
      messages: [
        { role: 'system', content: 'You are Luna, a playful and witty AI.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      maxOutputTokens: 500
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
      throw new Error(txt);
    }

    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.[0]?.text || data?.candidates?.[0]?.content?.text;
    return reply || null;

  } catch (e) {
    console.warn('Gemini failed:', e.message);
    return null;
  }
}

/* ---------------- GitHub AI fallback ---------------- */
const githubClient = new OpenAI({ apiKey: GITHUB_AI_TOKEN });
async function queryGitHubAI(prompt) {
  try {
    const response = await githubClient.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'You are Luna, a playful and witty AI.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (e) {
    console.error('GitHub AI error:', e);
    return 'Sorry, I cannot generate a reply at this time.';
  }
}

/* ---------------- Discord Bot ---------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });

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
    const fullPrompt = `User (${displayName}): ${message.content}\n${memoryText}`;

    // Try Gemini first
    let reply = await queryGemini(fullPrompt);
    if (!reply) reply = await queryGitHubAI(fullPrompt); // fallback

    await storeMemory(message.author.id, displayName, message.content);
    await storeMemory(message.author.id, displayName, `Luna: ${reply}`);

    await message.reply(reply);
  } catch (e) { console.error('messageCreate error:', e); }
});

client.login(DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
