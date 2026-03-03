import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { supabase } from '../supabase.js';
import { performOCR, parseAttributes } from '../utils/ocr.js';
import { createAnalysisEmbed, createConfigEmbed } from '../utils/embeds.js';
import { getConfirmRow, getDeleteRow } from '../utils/buttons.js';

export async function handleCommand(interaction) {
  const { commandName } = interaction;

  // ── /analyze ─────────────────────────────────────────────────────────────
  if (commandName === 'analyze') {
    const position   = interaction.options.getString('position').toUpperCase();
    const archetype  = interaction.options.getString('archetype');
    const attachment = interaction.options.getAttachment('screenshot');

    if (!attachment?.contentType?.startsWith('image/')) {
      return interaction.reply({ content: '❌ Please attach a valid image file.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let ocrText;
    try {
      await interaction.editReply('🔍 Running OCR — this may take 10–20 seconds...');
      ocrText = await performOCR(attachment.url);
    } catch (err) {
      console.error('OCR failed:', err);
      return interaction.editReply('❌ OCR failed. Try a clearer screenshot with better contrast.');
    }

    const attributes = parseAttributes(ocrText);

    if (Object.keys(attributes).length === 0) {
      return interaction.editReply('❌ No ratings found. Make sure the screenshot clearly shows attribute numbers.');
    }

    const { data: recruit, error } = await supabase
      .from('recruits')
      .insert({ user_id: interaction.user.id, position, archetype, attributes, status: 'pending' })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return interaction.editReply('❌ Failed to save recruit. Try again.');
    }

    await interaction.editReply({
      content: `Found **${Object.keys(attributes).length}** attributes. Review and confirm:`,
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruit.id)],
    });
  }

  // ── /config ──────────────────────────────────────────────────────────────
  if (commandName === 'config') {
    const position  = interaction.options.getString('position').toUpperCase();
    const archetype = interaction.options.getString('archetype');

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

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`config_edit_${position}_${archetype}`)
        .setLabel('✏️ Edit Ranges')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      embeds: [createConfigEmbed(position, archetype, arch.ranges)],
      components: [row],
      ephemeral: true,
    });
  }

  // ── /list-recruits ────────────────────────────────────────────────────────
  if (commandName === 'list-recruits') {
    const { data, error } = await supabase
      .from('recruits')
      .select('id, position, archetype, fit_score, created_at')
      .eq('user_id', interaction.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data?.length) {
      return interaction.reply({ content: '📭 No recruits saved yet. Use `/analyze` to add one!', ephemeral: true });
    }

    const lines = data.map(r => {
      const score = r.fit_score !== null ? `${r.fit_score}%` : 'Pending';
      const date  = new Date(r.created_at).toLocaleDateString();
      return `\`#${r.id}\` | **${r.position} ${r.archetype}** | Fit: ${score} | ${date}`;
    }).join('\n');

    await interaction.reply({ content: `**Your Recruits (last 20)**\n${lines}`, ephemeral: true });
  }

  // ── /clear-recruit ────────────────────────────────────────────────────────
  if (commandName === 'clear-recruit') {
    const id = interaction.options.getInteger('id');

    const { data } = await supabase
      .from('recruits')
      .select('id, position, archetype')
      .eq('id', id)
      .eq('user_id', interaction.user.id)
      .single();

    if (!data) {
      return interaction.reply({ content: `❌ Recruit #${id} not found or doesn't belong to you.`, ephemeral: true });
    }

    await interaction.reply({
      content: `Delete **#${id} — ${data.position} ${data.archetype}**? This cannot be undone.`,
      components: [getDeleteRow(id)],
      ephemeral: true,
    });
  }
}
