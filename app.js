import { Client, GatewayIntentBits, Partials } from "discord.js";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import { promisify } from "util";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!DISCORD_TOKEN || !GEMINI_API_KEY) {
  console.error("Set DISCORD_BOT_TOKEN and GEMINI_API_KEY in env.");
  process.exit(1);
}

/* ---------------- Personality ---------------- */
const PERSONALITY_PROMPT = `
You are "Luna", a playful, witty AI who loves strawberries and space.
Participate naturally in conversations, stay friendly, concise, and remember past chats.
`;

/* ---------------- SQLite Memory ---------------- */
const db = new sqlite3.Database('./memory.db', (err) => {
  if (err) return console.error(err.message);
  console.log("Connected to SQLite database");
});

db.run(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    user_name TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

async function storeMemory(userId, userName, content) {
  await dbRun(`INSERT INTO memories (user_id,user_name,content) VALUES(?,?,?)`, [userId, userName, content]);
}

async function fetchRecentMemories(userId, limit = 5) {
  const rows = await dbAll(
    `SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => r.content).reverse();
}

/* ---------------- Gemini Query ---------------- */
async function queryGemini(prompt) {
  const res = await fetch(
    "https://api.generativeai.google/v1beta2/models/text-bison-001:generate",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GEMINI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: prompt,
        maxOutputTokens: 250,
        temperature: 0.8
      })
    }
  );

  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.candidates[0].content;
}

/* ---------------- Discord Client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // Make sure this intent is enabled in Discord portal
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

/* ---------------- Autonomous Message Handler ---------------- */
const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25; // 25% chance to reply autonomously
const USER_COOLDOWN = 15000; // 15s per user cooldown

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const isMention = message.mentions.has(client.user);

    // Probability-based autonomous reply
    const isAutonomous = !isMention && Math.random() < RESPONSE_PROBABILITY;
    if (!isMention && !isAutonomous) return;

    // Cooldown per user
    const lastTime = COOLDOWN.get(message.author.id) || 0;
    const now = Date.now();
    if (now - lastTime < USER_COOLDOWN) return;
    COOLDOWN.set(message.author.id, now);

    // Fetch memory
    const mems = await fetchRecentMemories(message.author.id);
    const fullPrompt = PERSONALITY_PROMPT + "\n" + mems.map(m => `Memory: ${m}`).join("\n") + "\nUser: " + message.content;

    const aiReply = await queryGemini(fullPrompt);

    // Store memory
    await storeMemory(message.author.id, message.author.username, message.content);
    await storeMemory(message.author.id, message.author.username, `Luna: ${aiReply}`);

    await message.reply(aiReply);

  } catch (err) {
    console.error(err);
  }
});

/* ---------------- Discord Login ---------------- */
client.login(DISCORD_TOKEN);

/* ---------------- Minimal Web Server ---------------- */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Luna Discord Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

