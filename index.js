import './server.js';
import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';
import { config } from './config.js';
import { handleCommand } from './handlers/commands.js';
import { handleButton } from './handlers/buttons.js';
import { handleMessage } from './handlers/messages.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// userId → { type: 'recruit'|'config', id?, position?, archetype? }
export const activeEdits = new Map();

// Self-pinger to keep Render free tier awake
const RENDER_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : null);

if (RENDER_URL) {
  console.log(`Self-pinger → ${RENDER_URL}/ping every 3 min`);
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/ping`, { timeout: 5000 });
    } catch (err) {
      console.warn('Self-ping failed:', err.message);
    }
  }, 3 * 60 * 1000);
}

client.once('ready', () => console.log(`✅ Notes Server Bot online: ${client.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isButton())           return handleButton(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Something went wrong.', ephemeral: true };
    if (interaction.deferred)      interaction.editReply(msg);
    else if (!interaction.replied) interaction.reply(msg);
  }
});

client.on('messageCreate', async (message) => {
  try { await handleMessage(message); }
  catch (err) { console.error('Message error:', err); }
});

client.login(config.token);
