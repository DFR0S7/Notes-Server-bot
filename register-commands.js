import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

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

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('✅ Commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
