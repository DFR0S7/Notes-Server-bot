import { supabase } from '../supabase.js';
import { activeEdits } from '../index.js';
import { createAnalysisEmbed } from '../utils/embeds.js';
import { getConfirmRow } from '../utils/buttons.js';

export async function handleMessage(message) {
  if (message.author.bot) return;

  const session = activeEdits.get(message.author.id);
  if (!session) return;

  const text = message.content.trim();

  // ── cancel ────────────────────────────────────────────────────────────────
  if (text.toLowerCase() === 'cancel') {
    activeEdits.delete(message.author.id);
    return message.reply('❌ Edit session cancelled.');
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (text.toLowerCase() === 'done') {
    activeEdits.delete(message.author.id);

    if (session.type === 'recruit') {
      const { data: recruit } = await supabase.from('recruits').select('*').eq('id', session.id).single();
      return message.reply({
        content: '✅ Edits saved! Confirm to calculate fit score:',
        embeds: [createAnalysisEmbed(recruit)],
        components: [getConfirmRow(session.id)],
      });
    }

    if (session.type === 'config') {
      return message.reply(`✅ Ranges saved for **${session.position} ${session.archetype}**!`);
    }
  }

  // ── recruit attribute edit: "Speed: 92" ───────────────────────────────────
  if (session.type === 'recruit') {
    const match = text.match(/^([A-Za-z\s]+):\s*(\d+)$/);
    if (!match) return message.react('❓');

    const attr  = match[1].trim();
    const value = parseInt(match[2]);
    if (value < 1 || value > 99) return message.reply('❌ Value must be between 1 and 99.');

    const { data } = await supabase.from('recruits').select('attributes').eq('id', session.id).single();
    const updated  = { ...data.attributes, [attr]: value };
    await supabase.from('recruits').update({ attributes: updated }).eq('id', session.id);

    return message.reply(`Updated **${attr}** → ${value}`);
  }

  // ── config range edit: "Speed 85 95" ─────────────────────────────────────
  if (session.type === 'config') {
    const parts = text.split(/\s+/);
    if (parts.length < 3) return message.react('❓');

    const min  = parseInt(parts[parts.length - 2]);
    const max  = parseInt(parts[parts.length - 1]);
    const attr = parts.slice(0, parts.length - 2).join(' ');

    if (isNaN(min) || isNaN(max) || min >= max) {
      return message.reply('❌ Format: AttributeName min max (e.g. Speed 85 95). Min must be less than max.');
    }

    const { data: arch } = await supabase
      .from('archetypes')
      .select('ranges')
      .eq('position', session.position)
      .eq('archetype', session.archetype)
      .single();

    const ranges = { ...arch.ranges, [attr]: { min, max } };
    await supabase.from('archetypes')
      .update({ ranges })
      .eq('position', session.position)
      .eq('archetype', session.archetype);

    return message.reply(`✅ **${attr}** range set to ${min}–${max}`);
  }
}
