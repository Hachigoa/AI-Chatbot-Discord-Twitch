// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import express from 'express';
import OpenAI from 'openai';
import pkg from 'google-auth-library';
const { GoogleAuth } = pkg;

/* ---------------- env ---------------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || '';
const GITHUB_AI_KEY = process.env.GITHUB_AI_KEY;

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON || !GITHUB_AI_KEY) {
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

/* ---------------- Google Gemini ---------------- */
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
  if (!token) throw new Error('Failed to get Gemini token');
  cachedToken = token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function queryGemini(prompt) {
  try {
    console.log('Calling Gemini AI...');
    const token = await getGeminiToken();
    const model = GEMINI_MODEL_ENV || 'models/gemini-2.5-turbo';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateMessage`;
    const body = { 
      input: { text: prompt }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      throw new Error(`Gemini failed: ${txt}`);
    }
    const data = await res.json();
    const candidate = data?.output?.[0]?.content?.[0]?.text || "Sorry, I could not generate a reply.";
    console.log("Gemini returned:", candidate);
    return candidate;
  } catch(e) {
    console.error('Gemini failed:', e.message);
    return null;
  }
}

/* ---------------- GitHub AI ---------------- */
const githubClient = new OpenAI({ apiKey: GITHUB_AI_KEY });

async function queryGitHubAI(prompt) {
  try {
    console.log('Calling GitHub AI...');
    const response = await githubClient.chat.completions.create({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 300
    });
    const text = response.choices[0]?.message?.content || "Sorry, I could not generate a reply.";
    console.log("GitHub AI returned:", text);
    return text;
  } catch(e) {
    console.error('GitHub AI failed:', e.message);
    return null;
  }
}

/* ---------------- Discord Bot ---------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    console.log("Received message:", message.content);

    const displayName = message.member?.nickname || message.author.username;
    const mems = await fetchRecentMemories(message.author.id);
    const memoryText = mems.map(m => `Memory: ${m}`).join('\n');
    const fullPrompt = `You are Luna, a playful AI.\nUser (${displayName}): ${message.content}\n${memoryText}`;

    // Try Gemini first
    let reply = await queryGemini(fullPrompt);

    // If Gemini fails, fallback to GitHub AI
    if (!reply) {
      reply = await queryGitHubAI(fullPrompt);
    }

    if (!reply) reply = "Sorry, I couldn't generate a response.";

    await storeMemory(message.author.id, displayName, message.content);
    await storeMemory(message.author.id, displayName, `Luna: ${reply}`);

    await message.reply(reply);
  } catch(e) { console.error('messageCreate handler error:', e); }
});

client.login(DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
