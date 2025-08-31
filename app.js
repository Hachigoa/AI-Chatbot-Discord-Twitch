// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import pkg from 'google-auth-library';
const { GoogleAuth } = pkg;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON; // stringified service account JSON

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
  scopes: ['https://www.googleapis.com/auth/generative-language'] // ✅ fixed scope
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

/* ---------------- Gemini Query ---------------- */
async function queryGemini(prompt) {
  try {
    const token = await getAccessToken();
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

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
        Authorization: `Bearer ${token}`, // ✅ works with correct scope now
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini";
  } catch (e) {
    console.error('queryGemini error:', e);
    return 'Sorry, I cannot reach the AI right now.';
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
