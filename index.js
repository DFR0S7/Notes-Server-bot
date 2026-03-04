import './server.js';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import axios from 'axios';
import { config } from './config.js';
import { handleCommand, handleButton, handleMessage } from './handlers.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

export const activeEdits = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze a recruit screenshot')
    .addAttachmentOption(o => o.setName('screenshot').setDescription('Recruit screenshot').setRequired(true)),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set ideal attribute ranges for an archetype'),
  new SlashCommandBuilder()
    .setName('view-config')
    .setDescription('View configured ranges for a position and archetype'),
  new SlashCommandBuilder()
    .setName('add-archetype')
    .setDescription('Add a new archetype to a position')
    .addStringOption(o => o
      .setName('position')
      .setDescription('Position (e.g. ATH)')
      .setRequired(true))
    .addStringOption(o => o
      .setName('archetype')
      .setDescription('New archetype name')
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-recruits')
    .setDescription('View your saved recruits'),
  new SlashCommandBuilder()
    .setName('recruit-detail')
    .setDescription('View full attributes for a saved recruit')
    .addIntegerOption(o => o.setName('id').setDescription('Recruit ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clear-recruit')
    .setDescription('Delete a saved recruit by ID')
    .addIntegerOption(o => o.setName('id').setDescription('Recruit ID').setRequired(true)),
].map(c => c.toJSON());

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

const RENDER_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : null);

if (RENDER_URL) {
  console.log('Self-pinger active');
  setInterval(async () => {
    try { await axios.get(`${RENDER_URL}/ping`, { timeout: 5000 }); }
    catch (err) { console.warn('Self-ping failed:', err.message); }
  }, 3 * 60 * 1000);
}

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message ?? err));
client.on('error', (err) => console.error('Discord client error:', err.message));
client.on('shardError', (err) => console.error('Shard error:', err.message));

client.once('clientReady', () => console.log('Notes Server Bot online: ' + client.user.tag));

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isButton())           return handleButton(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: 'Something went wrong.', flags: 64 };
    if (interaction.deferred)      interaction.editReply(msg);
    else if (!interaction.replied) interaction.reply(msg);
  }
});

client.on('messageCreate', async (message) => {
  try { await handleMessage(message); }
  catch (err) { console.error('Message error:', err); }
});

start();
