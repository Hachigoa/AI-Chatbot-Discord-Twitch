// app.js - Luna Discord Bot with Gemini + GitHub AI

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import express from 'express';

// === Load environment variables ===
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!DISCORD_TOKEN || !GEMINI_API_KEY || !GITHUB_TOKEN) {
  console.error('Missing environment variables. Please set DISCORD_TOKEN, GEMINI_API_KEY, and GITHUB_TOKEN.');
  process.exit(1);
}

// === Initialize Express for status route ===
const app = express();
const PORT = process.env.PORT || 10000;

// === Initialize OpenAI clients ===
// Gemini client (primary)
const gemini = new OpenAI({
  apiKey: GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
});

// GitHub AI client (fallback)
const githubAI = new OpenAI({
  apiKey: GITHUB_TOKEN,
  baseURL: 'https://models.github.ai/inference/chat/completions'
});

// === Initialize SQLite database ===
const db = new Database('memory.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    user_message TEXT,
    bot_reply TEXT
  )
`).run();

// === Helper to fetch recent conversation ===
function getConversationHistory(userId, limit = 5) {
  const rows = db.prepare(`
    SELECT user_message, bot_reply 
    FROM memory 
    WHERE user_id = ? 
    ORDER BY id DESC 
    LIMIT ?
  `).all(userId, limit);
  
  const history = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    history.push({ role: 'user', content: rows[i].user_message });
    history.push({ role: 'assistant', content: rows[i].bot_reply });
  }
  return history;
}

// === Discord client ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages]
});

client.once('ready', () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
});

// === Message handler ===
client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignore bots

  const systemPrompt = { role: 'system', content: 'You are Luna, a friendly and witty AI assistant.' };
  const history = getConversationHistory(message.author.id, 5);
  const userPrompt = { role: 'user', content: message.content };
  const messages = [systemPrompt, ...history, userPrompt];

  let replyContent = '';

  // Try Gemini first
  try {
    const response = await gemini.chat.completions.create({
      model: 'gemini-2.5-pro', // Replace with your Gemini model
      messages: messages
    });
    replyContent = response.choices[0].message.content;
  } catch (geminiError) {
    console.error('Gemini API error:', geminiError);

    // Fallback to GitHub AI
    try {
      const response2 = await githubAI.chat.completions.create({
        model: 'openai/gpt-4o', // Example GitHub model
        messages: messages
      });
      replyContent = response2.choices[0].message.content;
    } catch (githubError) {
      console.error('GitHub AI error:', githubError);
      replyContent = "Sorry, I couldn’t think of a reply right now. Try again in a moment.";
    }
  }

  // Send the reply
  message.reply(replyContent).catch(console.error);

  // Store conversation in memory
  db.prepare(`
    INSERT INTO memory (user_id, user_message, bot_reply)
    VALUES (?, ?, ?)
  `).run(message.author.id, message.content, replyContent);
});

// === Express status route ===
app.get('/', async (req, res) => {
  try {
    const testMsg = await gemini.chat.completions.create({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 1
    });
    res.status(200).send('Luna Discord Bot is running ✅ AI service connected');
  } catch (error) {
    console.error('Status route AI connection error:', error);
    res.status(500).send('Luna Discord Bot is running ⚠️ AI service not ready');
  }
});

app.listen(PORT, () => console.log(`Express status server running on port ${PORT}`));
client.login(DISCORD_TOKEN);
