import { supabase } from '../supabase.js';
import { activeEdits } from '../index.js';
import { createAnalysisEmbed } from '../utils/embeds.js';
import { getConfirmRow } from '../utils/buttons.js';

export async function handleMessage(message) {
  if (message.author.bot) return;

  const session = activeEdits.get(message.author.id);
  if (!session) return;

  const text = message.content.trim();

  // cancel
  if (text.toLowerCase() === 'cancel') {
    activeEdits.delete(message.author.id);
    return message.reply('Edit session cancelled.');
  }

  // done
  if (text.toLowerCase() === 'done') {
    activeEdits.delete(message.author.id);

    if (session.type === 'recruit') {
      const { data: recruit } = await supabase.from('recruits').select('*').eq('id', session.id).single();
      return message.reply({
        content: 'Edits saved! Confirm to calculate fit score:',
        embeds: [createAnalysisEmbed(recruit)],
        components: [getConfirmRow(session.id)],
      });
    }

    if (session.type === 'config') {
      return message.reply('Ranges saved for ' + session.position + ' ' + session.archetype + '!');
    }
  }

  // recruit attribute edit: one per message "Speed: 92"
  if (session.type === 'recruit') {
    const match = text.match(/^([A-Za-z\s]+):\s*(\d+)$/);
    if (!match) return message.react('?');

    const attr  = match[1].trim();
    const value = parseInt(match[2]);
    if (value < 1 || value > 99) return message.reply('Value must be between 1 and 99.');

    const { data } = await supabase.from('recruits').select('attributes').eq('id', session.id).single();
    const updated  = { ...data.attributes, [attr]: value };
    await supabase.from('recruits').update({ attributes: updated }).eq('id', session.id);

    return message.reply('Updated ' + attr + ' to ' + value);
  }

  // config range edit: all at once, one per line "Speed 85 95"
  if (session.type === 'config') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const updates = {};
    const errors  = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) {
        errors.push('Could not parse: ' + line);
        continue;
      }

      const min  = parseInt(parts[parts.length - 2]);
      const max  = parseInt(parts[parts.length - 1]);
      const attr = parts.slice(0, parts.length - 2).join(' ');

      if (isNaN(min) || isNaN(max) || min >= max) {
        errors.push('Invalid range for: ' + line + ' (min must be less than max)');
        continue;
      }

      updates[attr] = { min, max };
    }

    if (Object.keys(updates).length === 0) {
      return message.reply('No valid ranges found. Format: AttributeName min max (e.g. Speed 85 95)');
    }

    // Merge with existing ranges
    const { data: arch } = await supabase
      .from('archetypes')
      .select('ranges')
      .eq('position', session.position)
      .eq('archetype', session.archetype)
      .single();

    const ranges = { ...arch.ranges, ...updates };
    await supabase.from('archetypes')
      .update({ ranges })
      .eq('position', session.position)
      .eq('archetype', session.archetype);

    const saved = Object.entries(updates)
      .map(([attr, { min, max }]) => attr + ': ' + min + '-' + max)
      .join('\n');

    let reply = 'Saved ' + Object.keys(updates).length + ' ranges:\n' + saved;
    if (errors.length) reply += '\n\nSkipped:\n' + errors.join('\n');
    reply += '\n\nType more ranges or "done" to finish.';

    return message.reply(reply);
  }
}
