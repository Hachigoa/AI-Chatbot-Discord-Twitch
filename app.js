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
You are "Luna", a playful, kind, slightly witty AI who loves strawberries and space.
Stay in-character. Keep replies friendly and concise. Remember past conversations.
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
      type TEXT,
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
async function storeMemory({ userId, userName, type='long', content }) {
  await db.run(
    `INSERT INTO memories (user_id, user_name, type, content) VALUES (?, ?, ?, ?)`,
    [userId, userName, type, content]
  );
}

async function fetchRelevantMemories(userId, limit=6) {
  const rows = await db.all(
    `SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => r.content).reverse();
}

/* ---------------- OpenAI Query ---------------- */
async function queryOpenAI(systemPrompt, conversationMessages) {
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...conversationMessages
    ],
    max_tokens: 500,
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

/* ---------------- Command Handler ---------------- */
async function handleCommand({ userId, userName, command, args, rawMessage }) {
  command = command?.toLowerCase?.();

  if (command === "remember") {
    const content = args.join(" ");
    if (!content) return "Usage: !remember <something>";
    await storeMemory({ userId, userName, content });
    return `Got it — I’ll remember: "${content}"`;
  }

  if (command === "recall") {
    const mems = await fetchRelevantMemories(userId, 6);
    return mems.length ? `I remember:\n${mems.join("\n")}` : "I don't have anything remembered yet.";
  }

  if (command === "forget") {
    await db.run(`DELETE FROM memories WHERE user_id = ?`, [userId]);
    return "Cleared your memories.";
  }

  // Default AI response
  const memoryStrings = await fetchRelevantMemories(userId, 6);
  const messages = memoryStrings.map(m => ({ role: "system", content: `Memory: ${m}` }));
  messages.push({ role: "user", content: rawMessage });

  const aiReply = await queryOpenAI(PERSONALITY_PROMPT, messages);

  await storeMemory({ userId, userName, type:'short', content: rawMessage });
  await storeMemory({ userId, userName, type:'short', content: `Luna: ${aiReply}` });

  return aiReply;
}

/* ---------------- Discord Listener ---------------- */
client.on("messageCreate", async message => {
  try {
    if (message.author.bot) return;

    const isMention = message.mentions.has(client.user);
    const isCommand = message.content.trim().startsWith("!");
    const isDM = message.channel.type === 1 || message.channel.type === "DM";

    if (!isMention && !isCommand && !isDM) return;

    let raw = message.content;
    let cmd = null, args = [];

    if (isCommand) {
      const parts = raw.slice(1).split(/\s+/);
      cmd = parts.shift();
      args = parts;
    } else if (isMention) {
      raw = raw.replace(/<@!?[0-9]+>/g,"").trim();
      const parts = raw.split(/\s+/);
      cmd = parts.shift();
      args = parts;
    }

    const payload = { userId: message.author.id, userName: message.author.username, command: cmd, args, rawMessage: raw };
    const reply = await handleCommand(payload);

    await message.reply(reply);

  } catch(err){ console.error(err); }
});

client.login(DISCORD_TOKEN);
