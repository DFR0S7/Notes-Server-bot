import './server.js';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
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

export const activeEdits = new Map();

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze a recruit screenshot')
    .addStringOption(o => o.setName('position').setDescription('Position e.g. QB').setRequired(true))
    .addStringOption(o => o.setName('archetype').setDescription('Archetype e.g. Field General').setRequired(true))
    .addAttachmentOption(o => o.setName('screenshot').setDescription('Recruit screenshot').setRequired(true)),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set ideal attribute ranges for an archetype')
    .addStringOption(o => o.setName('position').setDescription('Position').setRequired(true))
    .addStringOption(o => o.setName('archetype').setDescription('Archetype').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-recruits')
    .setDescription('View your saved recruits'),
  new SlashCommandBuilder()
    .setName('clear-recruit')
    .setDescription('Delete a saved recruit by ID')
    .addIntegerOption(o => o.setName('id').setDescription('Recruit ID').setRequired(true)),
].map(c => c.toJSON());

// Register commands then login
async function start() {
  try {
    console.log('Registering slash commands...');
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
  client.login(config.token);
}

// Self-pinger to keep Render free tier awake
const RENDER_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : null);

if (RENDER_URL) {
  console.log(`Self-pinger active`);
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/ping`, { timeout: 5000 });
    } catch (err) {
      console.warn('Self-ping failed:', err.message);
    }
  }, 3 * 60 * 1000);
}

// Crash protection
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message ?? err);
});

client.on('error', (err) => {
  console.error('Discord client error:', err.message);
});

client.on('shardError', (err) => {
  console.error('Shard error (will auto-reconnect):', err.message);
});

// Event handlers
client.once('ready', () => console.log(`Notes Server Bot online: ${client.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isButton())           return handleButton(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.deferred)      interaction.editReply(msg);
    else if (!interaction.replied) interaction.reply(msg);
  }
});

client.on('messageCreate', async (message) => {
  try { await handleMessage(message); }
  catch (err) { console.error('Message error:', err); }
});

start();
