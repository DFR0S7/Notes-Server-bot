import { supabase } from '../supabase.js';
import { createBreakdownEmbed } from '../utils/embeds.js';
import { calculateFit } from '../utils/fit.js';
import { activeEdits } from '../index.js';

export async function handleButton(interaction) {
  const parts  = interaction.customId.split('_');
  const action = parts[0];
  const sub    = parts[1];
  const rest   = parts.slice(2);

  // ── confirm_{id} ──────────────────────────────────────────────────────────
  if (action === 'confirm') {
    const id = parseInt(sub);
    await interaction.deferUpdate();

    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', id).single();
    if (!recruit) return interaction.editReply({ content: '❌ Recruit not found.', components: [] });

    const { score, breakdown, warning } = await calculateFit(
      recruit.position, recruit.archetype, recruit.attributes
    );

    await supabase.from('recruits').update({ fit_score: score, status: 'confirmed' }).eq('id', id);

    await interaction.editReply({
      content: `✅ Saved! Fit Score: **${score}%**`,
      embeds: [createBreakdownEmbed(score, breakdown, warning)],
      components: [],
    });
  }

  // ── edit_{id} ─────────────────────────────────────────────────────────────
  if (action === 'edit') {
    const id = parseInt(sub);
    activeEdits.set(interaction.user.id, { type: 'recruit', id });

    await interaction.reply({
      content: 'Edit Mode — reply with "AttributeName: value" (e.g. Speed: 92).\nType "done" to save or "cancel" to quit.',
      ephemeral: true,
    });
  }

  // ── cancel_{id} ───────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const id = parseInt(sub);
    await supabase.from('recruits').delete().eq('id', id);
    await interaction.update({ content: '🗑️ Recruit cancelled and removed.', components: [], embeds: [] });
  }

  // ── config_edit_{position}_{archetype} ────────────────────────────────────
  if (action === 'config' && sub === 'edit') {
    const position  = rest[0];
    const archetype = rest.slice(1).join('_');
    activeEdits.set(interaction.user.id, { type: 'config', position, archetype });

    await interaction.reply({
      content: 'Range Edit Mode — reply with "AttributeName min max" (e.g. Speed 85 95).\nType "done" to save.',
      ephemeral: true,
    });
  }

  // ── clear_yes_{id} ────────────────────────────────────────────────────────
  if (action === 'clear' && sub === 'yes') {
    const id = parseInt(rest[0]);
    await supabase.from('recruits').delete().eq('id', id);
    await interaction.update({ content: `🗑️ Recruit #${id} deleted.`, components: [] });
  }

  // ── clear_no_{id} ─────────────────────────────────────────────────────────
  if (action === 'clear' && sub === 'no') {
    await interaction.update({ content: '👍 Cancelled. No changes made.', components: [] });
  }
}
