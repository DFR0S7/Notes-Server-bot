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

// CFB26 positions for autocomplete
export const POSITIONS = ['QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S','Other'];

// CFB26 archetypes per position
export const ARCHETYPES = {
  QB:  ['Backfield Creator','Dual Threat','Pocket Passer','Pure Runner','Other'],
  HB:  ['Elusive Bruiser','Backfield Threat','NS Receiver','NS Blocker','Contact Seeker','East-West Playmaker','Other'],
  WR:  ['Gadget','Physical Route Runner','Elusive Route Runner','Speedster','Contested Specialist','Gritty Possession','Route Artist','Other'],
  TE:  ['Physical Route Runner','Vertical Threat','Pure Blocker','Possession','Other'],
  OT:  ['Raw Strength','Well Rounded','Pass Protector','Agile','Other'],
  OG:  ['Raw Strength','Well Rounded','Pass Protector','Agile','Other'],
  C:   ['Raw Strength','Well Rounded','Pass Protector','Agile','Other'],
  DE:  ['Speed Rusher','Edge Setter','Power Rusher','Other'],
  DT:  ['Pure Power','Gap Specialist','Speed Rusher','Power Rusher','Other'],
  LB:  ['Lurker','Signal Caller','Thumper','Other'],
  CB:  ['Field','Zone','Bump','Boundary','Other'],
  S:   ['Coverage Specialist','Hybrid','Box','Other'],
  Other: ['Other'],
};

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze a recruit screenshot')
    .addStringOption(o => o
      .setName('position')
      .setDescription('Position')
      .setRequired(true)
      .addChoices(...POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o
      .setName('archetype')
      .setDescription('Archetype — if your archetype is not listed, pick Other and use custom_archetype')
      .setRequired(true)
      .addChoices(
        { name: 'Backfield Creator', value: 'Backfield Creator' },
        { name: 'Dual Threat', value: 'Dual Threat' },
        { name: 'Pocket Passer', value: 'Pocket Passer' },
        { name: 'Pure Runner', value: 'Pure Runner' },
        { name: 'Elusive Bruiser', value: 'Elusive Bruiser' },
        { name: 'Backfield Threat', value: 'Backfield Threat' },
        { name: 'NS Receiver', value: 'NS Receiver' },
        { name: 'NS Blocker', value: 'NS Blocker' },
        { name: 'Contact Seeker', value: 'Contact Seeker' },
        { name: 'East-West Playmaker', value: 'East-West Playmaker' },
        { name: 'Gadget', value: 'Gadget' },
        { name: 'Physical Route Runner', value: 'Physical Route Runner' },
        { name: 'Elusive Route Runner', value: 'Elusive Route Runner' },
        { name: 'Speedster', value: 'Speedster' },
        { name: 'Contested Specialist', value: 'Contested Specialist' },
        { name: 'Gritty Possession', value: 'Gritty Possession' },
        { name: 'Route Artist', value: 'Route Artist' },
        { name: 'Vertical Threat', value: 'Vertical Threat' },
        { name: 'Pure Blocker', value: 'Pure Blocker' },
        { name: 'Possession', value: 'Possession' },
        { name: 'Raw Strength', value: 'Raw Strength' },
        { name: 'Well Rounded', value: 'Well Rounded' },
        { name: 'Pass Protector', value: 'Pass Protector' },
        { name: 'Agile', value: 'Agile' },
        { name: 'Edge Setter', value: 'Edge Setter' },
        { name: 'Power Rusher', value: 'Power Rusher' },
        { name: 'Speed Rusher', value: 'Speed Rusher' },
        { name: 'Pure Power', value: 'Pure Power' },
        { name: 'Gap Specialist', value: 'Gap Specialist' },
        { name: 'Lurker', value: 'Lurker' },
        { name: 'Signal Caller', value: 'Signal Caller' },
        { name: 'Thumper', value: 'Thumper' },
        { name: 'Field', value: 'Field' },
        { name: 'Zone', value: 'Zone' },
        { name: 'Bump', value: 'Bump' },
        { name: 'Boundary', value: 'Boundary' },
        { name: 'Coverage Specialist', value: 'Coverage Specialist' },
        { name: 'Hybrid', value: 'Hybrid' },
        { name: 'Box', value: 'Box' },
        { name: 'Other', value: 'Other' },
      ))
    .addAttachmentOption(o => o.setName('screenshot').setDescription('Recruit screenshot').setRequired(true))
    .addStringOption(o => o
      .setName('custom_archetype')
      .setDescription('If you selected Other for archetype, type it here')
      .setRequired(false)),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set ideal attribute ranges for an archetype')
    .addStringOption(o => o
      .setName('position')
      .setDescription('Position')
      .setRequired(true)
      .addChoices(...POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o
      .setName('archetype')
      .setDescription('Archetype — if your archetype is not listed, pick Other and use custom_archetype')
      .setRequired(true)
      .addChoices(
        { name: 'Backfield Creator', value: 'Backfield Creator' },
        { name: 'Dual Threat', value: 'Dual Threat' },
        { name: 'Pocket Passer', value: 'Pocket Passer' },
        { name: 'Pure Runner', value: 'Pure Runner' },
        { name: 'Elusive Bruiser', value: 'Elusive Bruiser' },
        { name: 'Backfield Threat', value: 'Backfield Threat' },
        { name: 'NS Receiver', value: 'NS Receiver' },
        { name: 'NS Blocker', value: 'NS Blocker' },
        { name: 'Contact Seeker', value: 'Contact Seeker' },
        { name: 'East-West Playmaker', value: 'East-West Playmaker' },
        { name: 'Gadget', value: 'Gadget' },
        { name: 'Physical Route Runner', value: 'Physical Route Runner' },
        { name: 'Elusive Route Runner', value: 'Elusive Route Runner' },
        { name: 'Speedster', value: 'Speedster' },
        { name: 'Contested Specialist', value: 'Contested Specialist' },
        { name: 'Gritty Possession', value: 'Gritty Possession' },
        { name: 'Route Artist', value: 'Route Artist' },
        { name: 'Vertical Threat', value: 'Vertical Threat' },
        { name: 'Pure Blocker', value: 'Pure Blocker' },
        { name: 'Possession', value: 'Possession' },
        { name: 'Raw Strength', value: 'Raw Strength' },
        { name: 'Well Rounded', value: 'Well Rounded' },
        { name: 'Pass Protector', value: 'Pass Protector' },
        { name: 'Agile', value: 'Agile' },
        { name: 'Edge Setter', value: 'Edge Setter' },
        { name: 'Power Rusher', value: 'Power Rusher' },
        { name: 'Speed Rusher', value: 'Speed Rusher' },
        { name: 'Pure Power', value: 'Pure Power' },
        { name: 'Gap Specialist', value: 'Gap Specialist' },
        { name: 'Lurker', value: 'Lurker' },
        { name: 'Signal Caller', value: 'Signal Caller' },
        { name: 'Thumper', value: 'Thumper' },
        { name: 'Field', value: 'Field' },
        { name: 'Zone', value: 'Zone' },
        { name: 'Bump', value: 'Bump' },
        { name: 'Boundary', value: 'Boundary' },
        { name: 'Coverage Specialist', value: 'Coverage Specialist' },
        { name: 'Hybrid', value: 'Hybrid' },
        { name: 'Box', value: 'Box' },
        { name: 'Other', value: 'Other' },
      ))
    .addStringOption(o => o
      .setName('custom_archetype')
      .setDescription('If you selected Other for archetype, type it here')
      .setRequired(false)),

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
  console.log('Self-pinger active');
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
client.once('ready', () => console.log('Notes Server Bot online: ' + client.user.tag));

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
