// app.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import { google } from "google-auth-library";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON) {
  console.error("Set DISCORD_BOT_TOKEN and GEMINI_CREDENTIALS_JSON in env.");
  process.exit(1);
}

/* ---------------- Personality ---------------- */
const PERSONALITY_PROMPT = `
You are "Luna", a playful, witty AI who loves strawberries and space.
Participate naturally in conversations, stay friendly, concise, and remember past chats.
`;

/* ---------------- SQLite Memory ---------------- */
let db;
(async () => {
  db = await open({
    filename: "./memory.db",
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
  console.log("Connected to SQLite database");
})();

/* ---------------- Discord Client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => console.log(`Discord bot ready as ${client.user.tag}`));

/* ---------------- Helpers ---------------- */
async function storeMemory(userId, userName, content) {
  await db.run(
    `INSERT INTO memories (user_id,user_name,content) VALUES(?,?,?)`,
    [userId, userName, content]
  );
}

async function fetchRecentMemories(userId, limit = 5) {
  const rows = await db.all(
    `SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => r.content).reverse();
}

/* ---------------- Gemini Query ---------------- */
const credentials = JSON.parse(GEMINI_CREDENTIALS_JSON);

async function getAccessToken() {
  const client = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const tokenResponse = await client.authorize();
  return tokenResponse.access_token;
}

async function queryGemini(prompt) {
  const token = await getAccessToken();

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: { text: prompt },
        temperature: 0.8,
        maxOutputTokens: 300
      })
    }
  );

  const data = await res.json();
  if (!data || !data.candidates || !data.candidates[0]) {
    throw new Error("Invalid Gemini API response");
  }
  return data.candidates[0].content;
}

/* ---------------- Discord Message Handler ---------------- */
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
    const fullPrompt =
      PERSONALITY_PROMPT +
      "\n" +
      mems.map(m => `Memory: ${m}`).join("\n") +
      "\nUser: " +
      message.content;

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

