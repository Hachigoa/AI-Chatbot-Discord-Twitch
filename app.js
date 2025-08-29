// app.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import Database from "better-sqlite3";
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import { GoogleAuth } from "google-auth-library";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_CREDENTIALS = process.env.GEMINI_CREDENTIALS_JSON; // JSON string of service account

if (!DISCORD_TOKEN || !GEMINI_CREDENTIALS) {
  console.error("Set DISCORD_BOT_TOKEN and GEMINI_CREDENTIALS_JSON in env.");
  process.exit(1);
}

/* ---------------- Personality ---------------- */
const PERSONALITY_PROMPT = `
You are "Luna", a playful, witty AI who loves strawberries and space.
Participate naturally in conversations, stay friendly, concise, and remember past chats.
`;

/* ---------------- SQLite Memory ---------------- */
const db = new Database("./memory.db");
db.prepare(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  user_name TEXT,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

function storeMemory(userId, userName, content) {
  db.prepare("INSERT INTO memories (user_id,user_name,content) VALUES(?,?,?)")
    .run(userId, userName, content);
}

function fetchRecentMemories(userId, limit=5) {
  const rows = db.prepare("SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
                 .all(userId, limit);
  return rows.map(r => r.content).reverse();
}

/* ---------------- Gemini OAuth ---------------- */
const auth = new GoogleAuth({
  credentials: JSON.parse(GEMINI_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});

async function getGeminiAccessToken() {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

/* ---------------- Gemini Query ---------------- */
async function queryGemini(prompt) {
  const token = await getGeminiAccessToken();
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      temperature: 0.8,
      maxOutputTokens: 250
    })
  });

  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.candidates[0].output;
}

/* ---------------- Discord Client ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

/* ---------------- Autonomous Handler ---------------- */
const COOLDOWN = new Map();
const RESPONSE_PROBABILITY = 0.25; // 25% chance to reply autonomously
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

    const mems = fetchRecentMemories(message.author.id);
    const fullPrompt = PERSONALITY_PROMPT + "\n" + mems.map(m => `Memory: ${m}`).join("\n") + "\nUser: " + message.content;

    const aiReply = await queryGemini(fullPrompt);

    storeMemory(message.author.id, message.author.username, message.content);
    storeMemory(message.author.id, message.author.username, `Luna: ${aiReply}`);

    await message.reply(aiReply);

  } catch(err) {
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

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
