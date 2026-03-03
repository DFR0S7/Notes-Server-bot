import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export function getConfirmRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${recruitId}`)
      .setLabel('✅ Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`edit_${recruitId}`)
      .setLabel('✏️ Edit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cancel_${recruitId}`)
      .setLabel('❌ Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

export function getDeleteRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clear_yes_${recruitId}`)
      .setLabel('🗑️ Delete')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`clear_no_${recruitId}`)
      .setLabel('Keep')
      .setStyle(ButtonStyle.Secondary),
  );
}
