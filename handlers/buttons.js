import { supabase } from '../supabase.js';
import { createAnalysisEmbed, createBreakdownEmbed, createConfigEmbed } from '../utils/embeds.js';
import { calculateFit } from '../utils/fit.js';
import { getArchetypeRows, getConfirmRow } from '../utils/buttons.js';
import { activeEdits } from '../index.js';
import { performOCR, parseAttributes } from '../utils/ocr.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export async function handleButton(interaction) {
  const id = interaction.customId;

  // ── analyze_pos_{POSITION} — user picked a position for analyze ───────────
  if (id.startsWith('analyze_pos_')) {
    const position = id.replace('analyze_pos_', '');
    const session  = activeEdits.get(interaction.user.id);

    if (!session?.attachmentUrl) {
      return interaction.update({ content: 'Session expired. Please run /analyze again.', components: [] });
    }

    // Save position to session
    activeEdits.set(interaction.user.id, { ...session, position });

    await interaction.update({
      content: 'Position: **' + position + '**\nStep 2: Select an archetype',
      components: getArchetypeRows('analyze', position),
    });
  }

  // ── analyze_arch_{POSITION}_{ARCHETYPE} — user picked archetype, run OCR ──
  if (id.startsWith('analyze_arch_')) {
    const withoutPrefix = id.replace('analyze_arch_', '');
    const underscoreIdx = withoutPrefix.indexOf('_');
    const position  = withoutPrefix.substring(0, underscoreIdx);
    const archetype = withoutPrefix.substring(underscoreIdx + 1);
    const session   = activeEdits.get(interaction.user.id);

    if (!session?.attachmentUrl) {
      return interaction.update({ content: 'Session expired. Please run /analyze again.', components: [] });
    }

    await interaction.update({ content: 'Running OCR — this may take 10-20 seconds...', components: [] });

    let ocrText;
    try {
      ocrText = await performOCR(session.attachmentUrl);
    } catch (err) {
      console.error('OCR failed:', err);
      activeEdits.delete(interaction.user.id);
      return interaction.editReply({ content: 'OCR failed. Try a clearer screenshot and run /analyze again.' });
    }

    const attributes = parseAttributes(ocrText);
    activeEdits.delete(interaction.user.id);

    if (Object.keys(attributes).length === 0) {
      return interaction.editReply({ content: 'No ratings found. Make sure the screenshot clearly shows attribute numbers.' });
    }

    const { data: recruit, error } = await supabase
      .from('recruits')
      .insert({ user_id: interaction.user.id, position, archetype, attributes, status: 'pending' })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return interaction.editReply({ content: 'Failed to save recruit. Try again.' });
    }

    await interaction.editReply({
      content: 'Found **' + Object.keys(attributes).length + '** attributes for **' + position + ' ' + archetype + '**. Review and confirm:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruit.id)],
    });
  }

  // ── config_pos_{POSITION} — user picked a position for config ─────────────
  if (id.startsWith('config_pos_')) {
    const position = id.replace('config_pos_', '');

    await interaction.update({
      content: 'Position: **' + position + '**\nStep 2: Select an archetype',
      components: getArchetypeRows('config', position),
    });
  }

  // ── config_arch_{POSITION}_{ARCHETYPE} — show/edit ranges ─────────────────
  if (id.startsWith('config_arch_')) {
    const withoutPrefix = id.replace('config_arch_', '');
    const underscoreIdx = withoutPrefix.indexOf('_');
    const position  = withoutPrefix.substring(0, underscoreIdx);
    const archetype = withoutPrefix.substring(underscoreIdx + 1);

    let { data: arch } = await supabase
      .from('archetypes')
      .select('ranges')
      .eq('position', position)
      .eq('archetype', archetype)
      .single();

    if (!arch) {
      await supabase.from('archetypes').insert({ position, archetype, ranges: {} });
      arch = { ranges: {} };
    }

    const editRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('config_edit_' + position + '_' + archetype)
        .setLabel('Edit Ranges')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.update({
      content: '',
      embeds: [createConfigEmbed(position, archetype, arch.ranges)],
      components: [editRow],
    });
  }

  // ── confirm_{id} ──────────────────────────────────────────────────────────
  if (id.startsWith('confirm_')) {
    const recruitId = parseInt(id.replace('confirm_', ''));
    await interaction.deferUpdate();

    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', recruitId).single();
    if (!recruit) return interaction.editReply({ content: 'Recruit not found.', components: [] });

    const { score, breakdown, warning } = await calculateFit(
      recruit.position, recruit.archetype, recruit.attributes
    );

    await supabase.from('recruits').update({ fit_score: score, status: 'confirmed' }).eq('id', recruitId);

    await interaction.editReply({
      content: 'Saved! Fit Score: **' + score + '%**',
      embeds: [createBreakdownEmbed(score, breakdown, warning)],
      components: [],
    });
  }

  // ── edit_{id} ─────────────────────────────────────────────────────────────
  if (id.startsWith('edit_') && !id.startsWith('edit_ranges')) {
    const recruitId = parseInt(id.replace('edit_', ''));
    activeEdits.set(interaction.user.id, { type: 'recruit', id: recruitId });

    await interaction.reply({
      content: 'Edit Mode - reply with "AttributeName: value" (e.g. Speed: 92).\nType "done" to save or "cancel" to quit.',
      ephemeral: true,
    });
  }

  // ── cancel_{id} ───────────────────────────────────────────────────────────
  if (id.startsWith('cancel_')) {
    const recruitId = parseInt(id.replace('cancel_', ''));
    await supabase.from('recruits').delete().eq('id', recruitId);
    await interaction.update({ content: 'Recruit cancelled and removed.', components: [], embeds: [] });
  }

  // ── config_edit_{position}_{archetype} — enter range edit mode ────────────
  if (id.startsWith('config_edit_')) {
    const withoutPrefix = id.replace('config_edit_', '');
    const underscoreIdx = withoutPrefix.indexOf('_');
    const position  = withoutPrefix.substring(0, underscoreIdx);
    const archetype = withoutPrefix.substring(underscoreIdx + 1);

    activeEdits.set(interaction.user.id, { type: 'config', position, archetype });

    await interaction.reply({
      content: 'Range Edit Mode - paste all ranges at once, one per line:\nExample:\nSpeed 82 95\nThrow Power 88 99\n\nType "done" when finished.',
      ephemeral: true,
    });
  }

  // ── clear_yes_{id} ────────────────────────────────────────────────────────
  if (id.startsWith('clear_yes_')) {
    const recruitId = parseInt(id.replace('clear_yes_', ''));
    await supabase.from('recruits').delete().eq('id', recruitId);
    await interaction.update({ content: 'Recruit #' + recruitId + ' deleted.', components: [] });
  }

  // ── clear_no_{id} ─────────────────────────────────────────────────────────
  if (id.startsWith('clear_no_')) {
    await interaction.update({ content: 'Cancelled. No changes made.', components: [] });
  }
}
