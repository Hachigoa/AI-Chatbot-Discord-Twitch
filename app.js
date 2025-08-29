

// app.js
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import { GoogleAuth } from 'google-auth-library';

// ---------- EXPRESS SERVER ----------
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot server is running!');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// ---------- SQLITE DATABASE ----------
let db;
(async () => {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });
  console.log('Connected to SQLite database');
})();

// ---------- GOOGLE GEMINI SETUP ----------
const credentials = JSON.parse(process.env.GEMINI_CREDENTIALS_JSON);

const auth = new GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function queryGemini(prompt) {
  try {
    const client = await auth.getClient();
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${(await client.getAccessToken()).token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: { text: prompt },
        temperature: 0.7,
        candidateCount: 1
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.[0]?.text || "No response";
  } catch (err) {
    console.error('Gemini query error:', err);
    return 'Error connecting to Gemini API';
  }
}

// ---------- DISCORD BOT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('clientReady', () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!ask ')) {
    const prompt = message.content.slice(5);
    const reply = await queryGemini(prompt);
    message.reply(reply);
  }
});

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN);
