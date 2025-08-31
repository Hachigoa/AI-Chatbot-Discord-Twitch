// app.js - Luna Discord Bot "Neuro-sama Style"
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import pkg from 'google-auth-library';
import OpenAI from 'openai';
import express from 'express';

const { GoogleAuth } = pkg;

// --- Environment Variables ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || 'models/gemini-2.5-chat';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

// --- Express for uptime ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send("Luna Discord Bot is alive 🌟"));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// --- SQLite Memory Setup ---
let db;
(async () => {
  db = await open({ filename: './memory.db', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      user_name TEXT,
      content TEXT,
      mood TEXT,
      personality TEXT,
      response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Connected to SQLite database');
})();

// --- Memory Functions ---
async function storeMemory(userId, userName, content, mood, personality, response) {
  try {
    await db.run(
      `INSERT INTO memories (user_id, user_name, content, mood, personality, response) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, userName, content, mood, personality, response]
    );
  } catch (e) {
    console.error('storeMemory error:', e);
  }
}

async function fetchRecentMemories(userId, limit = 5) {
  try {
    const rows = await db.all(
      `SELECT content, mood, personality, response FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.reverse().map(r =>
      `User (Mood: ${r.mood}, Personality: ${r.personality}): ${r.content}\nLuna: ${r.response}`
    ).join('\n');
  } catch (e) {
    console.error('fetchRecentMemories error:', e);
    return '';
  }
}

// --- Google Auth (Gemini) ---
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);
const googleAuth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/generative-language']
});

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

// --- Gemini API ---
async function queryGemini(prompt) {
  try {
    const token = await getAccessToken();
    const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL_ENV}:generateMessage`;
    const body = {
      messages: [{ author: "user", content: [{ type: "text", text: prompt }] }],
      temperature: 0.8,
      maxOutputTokens: 400
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('Gemini API error:', res.status, txt);
      throw new Error(`Gemini failed: ${txt}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.[0]?.text || data?.output?.[0]?.content?.[0]?.text || "I couldn't generate a reply.";
  } catch (e) {
    console.warn('Gemini failed, switching to GitHub AI:', e.message);
    return queryGitHubAI(prompt);
  }
}

// --- GitHub AI fallback ---
const githubClient = new OpenAI({ baseURL: "https://models.github.ai/inference", apiKey: GITHUB_TOKEN });

async function queryGitHubAI(prompt) {
  if (!GITHUB_TOKEN) return 'No GitHub AI token provided.';
  try {
    const response = await githubClient.chat.completions.create({
      model: "openai/gpt-4o",
      messages: [
        { role: "system", content: "You are Luna, a playful, witty AI who loves strawberries and space. Remember user personality, mood, and context for a Neuro-sama style interaction." },
        { role: "user", content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 400
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error('GitHub AI error:', err);
    return 'Sorry, I cannot generate a reply right now.';
  }
}

// --- Discord Bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageMentions
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

const COOLDOWN = new Map();
const USER_COOLDOWN_MS = 5000; // faster for Neuro-sama style

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    // Detect mention or name
    const mentioned = message.mentions.users.has(client.user.id);
    const calledByName = message.content.toLowerCase().includes('luna');
    if (!mentioned && !calledByName) return;

    const last = COOLDOWN.get(message.author.id) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) return;
    COOLDOWN.set(message.author.id, Date.now());

    const displayName = message.member?.nickname || message.author.username;
    const recentMemories = await fetchRecentMemories(message.author.id);

    // Include personality/mood detection prompt
    const fullPrompt = `
User (${displayName}): ${message.content}
Recent Memories:
${recentMemories}

Please also assess the user's current mood and personality for context. Respond in a natural, playful, Neuro-sama style, remembering prior conversations.
`;

    const reply = await queryGemini(fullPrompt);

    // Extract mood/personality if needed (simplified)
    const mood = 'neutral';
    const personality = 'friendly';

    await storeMemory(message.author.id, displayName, message.content, mood, personality, reply);
    await message.reply(reply);

  } catch (e) {
    console.error('messageCreate handler error:', e);
  }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
