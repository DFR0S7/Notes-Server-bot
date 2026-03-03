import { EmbedBuilder } from 'discord.js';

export function createAnalysisEmbed(recruit) {
  const attrs = recruit.attributes || {};
  const attrText = Object.entries(attrs)
    .map(([k, v]) => `**${k}**: ${v}`)
    .join('\n') || 'No attributes found';

  return new EmbedBuilder()
    .setTitle(`📋 ${recruit.position} — ${recruit.archetype}`)
    .setDescription('Review the extracted attributes below. Confirm to calculate fit score.')
    .addFields({ name: 'Attributes', value: attrText })
    .setColor(0x3498db)
    .setFooter({ text: `Recruit ID: ${recruit.id}` })
    .setTimestamp();
}

export function createBreakdownEmbed(score, breakdown, warning = null) {
  const color = score >= 80 ? 0x2ecc71 : score >= 60 ? 0xf39c12 : 0xe74c3c;
  const icon  = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';

  const lines = breakdown.map(b =>
    `${b.pass ? '✅' : '❌'} **${b.attr}**: ${b.value} _(range: ${b.min}–${b.max})_`
  ).join('\n') || 'No data';

  const embed = new EmbedBuilder()
    .setTitle(`${icon} Fit Score: ${score}%`)
    .addFields({ name: 'Attribute Breakdown', value: lines })
    .setColor(color)
    .setTimestamp();

  if (warning) embed.setFooter({ text: `⚠️ ${warning}` });
  return embed;
}

export function createConfigEmbed(position, archetype, ranges) {
  const rangeText = Object.entries(ranges)
    .map(([k, v]) => `**${k}**: ${v.min}–${v.max}`)
    .join('\n') || '_No ranges set yet_';

  return new EmbedBuilder()
    .setTitle(`⚙️ Config: ${position} — ${archetype}`)
    .setDescription('Current ideal attribute ranges:')
    .addFields({ name: 'Ranges', value: rangeText })
    .setColor(0x9b59b6)
    .setTimestamp();
}
