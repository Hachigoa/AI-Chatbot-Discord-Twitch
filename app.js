// app.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import express from "express";
import dotenv from "dotenv";
import { GenerativeLanguageServiceClient } from "@google-ai/generative";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_CREDENTIALS_JSON = process.env.GEMINI_CREDENTIALS_JSON;

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS_JSON) {
  console.error("Missing DISCORD_BOT_TOKEN or GEMINI_CREDENTIALS_JSON in env.");
  process.exit(1);
}

/* ---------------- Personality ---------------- */
const PERSONALITY_PROMPT = `
You are "Luna", a playful, witty AI who loves strawberries and space.
Participate naturally in conversations, stay friendly, concise, and remember past chats.
`;

/* ---------------- SQLite (sqlite + sqlite3) ---------------- */
let db;
(async () => {
  // open() with sqlite3 driver
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

async function storeMemory(userId, userName, content) {
  await db.run(
    `INSERT INTO memories (user_id, user_name, content) VALUES (?, ?, ?)`,
    [userId, userName, content]
  );
}

async function fetchRecentMemories(userId, limit = 5) {
  const rows = await db.all(
    `SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => r.content).reverse();
}

/* ---------------- Gemini client ---------------- */
const geminiClient = new GenerativeLanguageServiceClient({
  credentials: JSON.parse(GEMINI_CREDENTIALS_JSON)
});

async function queryGemini(prompt) {
  // This uses the client helper to call the model
  const response = await geminiClient.generateText({
    model: "models/gemini-2.0-flash",
    prompt: { text: prompt },
    temperature: 0.8,
    maxOutputTokens: 300
  });
  // Response format: response[0].candidates[0].content (depends on lib version)
  // defensive checks:
  if (!response || !response[0] || !response[0].candidates || !response[0].candidates[0]) {
    throw new Error("Unexpected Gemini response format");
  }
  return response[0].candidates[0].content;
}

/* ---------------- Discord client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // make sure this is enabled in Developer Portal
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
});

/* ---------------- Autonomous message handler ---------------- */
const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25; // 25% autonomous chance
const USER_COOLDOWN = 15000; // 15s

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const isMention = message.mentions.has(client.user);
    const isAutonomous = !isMention && Math.random() < RESPONSE_PROBABILITY;
    if (!isMention && !isAutonomous) return;

    const lastTime = COOLDOWN.get(message.author.id) || 0;
    const now = Date.now();
    if (now - lastTime < USER_COOLDOWN) return;
    COOLDOWN.set(message.author.id, now);

    const mems = await fetchRecentMemories(message.author.id);
    const memoryText = mems.map(m => `Memory: ${m}`).join("\n");
    const fullPrompt = `${PERSONALITY_PROMPT}\n${memoryText}\nUser: ${message.content}`;

    const aiReply = await queryGemini(fullPrompt);

    await storeMemory(message.author.id, message.author.username, message.content);
    await storeMemory(message.author.id, message.author.username, `Luna: ${aiReply}`);

    await message.reply(aiReply);

  } catch (err) {
    console.error("message handler error:", err);
  }
});

client.login(DISCORD_TOKEN);

/* ---------------- Minimal Express web server (for Render) ---------------- */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Luna Discord Bot is running"));

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});
