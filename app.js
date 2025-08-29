import { Client, GatewayIntentBits, Partials } from "discord.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!DISCORD_TOKEN || !OPENAI_KEY) {
  console.error("Set DISCORD_BOT_TOKEN and OPENAI_API_KEY in env.");
  process.exit(1);
}

/* ---------------- Personality ---------------- */
const PERSONALITY_PROMPT = `
You are "Luna", a playful, kind, witty AI who loves strawberries and space.
Stay in-character, friendly, and concise. Remember past conversations.
`;

/* ---------------- SQLite Memory ---------------- */
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
})();

/* ---------------- Discord Bot ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => console.log(`Discord bot ready as ${client.user.tag}`));

/* ---------------- Memory Helpers ---------------- */
async function storeMemory(userId, userName, content) {
  await db.run(
    `INSERT INTO memories (user_id, user_name, content) VALUES (?, ?, ?)`,
    [userId, userName, content]
  );
}

async function fetchRecentMemories(userId, limit=5) {
  const rows = await db.all(
    `SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => r.content).reverse();
}

/* ---------------- OpenAI Query ---------------- */
async function queryOpenAI(systemPrompt, messages) {
  const body = {
    model: "gpt-4o-mini",
    messages,
    max_tokens: 250,
    temperature: 0.8
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.choices[0].message.content;
}

/* ---------------- Message Handler ---------------- */
client.on("messageCreate", async message => {
  try {
    if (message.author.bot) return; // ignore other bots

    // Optionally, only reply if mentioned or DM
    const isMention = message.mentions.has(client.user);
    const isDM = message.channel.type === 1 || message.channel.type === "DM";

    if (!isMention && !isDM) return; // respond naturally only to mentions or DMs

    // Fetch recent memory
    const memoryStrings = await fetchRecentMemories(message.author.id);
    const messages = memoryStrings.map(m => ({ role:"system", content:`Memory: ${m}` }));
    messages.push({ role:"user", content: message.content });

    const aiReply = await queryOpenAI(PERSONALITY_PROMPT, messages);

    // Store memory
    await storeMemory(message.author.id, message.author.username, message.content);
    await storeMemory(message.author.id, message.author.username, `Luna: ${aiReply}`);

    await message.reply(aiReply);

  } catch(err) {
    console.error(err);
  }
});

client.login(DISCORD_TOKEN);

