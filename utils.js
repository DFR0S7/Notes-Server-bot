import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { supabase } from './supabase.js';

// ── CFB26 Positions & Archetypes ─────────────────────────────────────────────
export const POSITIONS = ['QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S'];

export const ARCHETYPES = {
  QB:  ['Backfield Creator','Dual Threat','Pocket Passer','Pure Runner'],
  HB:  ['Elusive Bruiser','Backfield Threat','NS Receiver','NS Blocker','Contact Seeker','East-West Playmaker'],
  WR:  ['Gadget','Physical Route Runner','Elusive Route Runner','Speedster','Contested Specialist','Gritty Possession','Route Artist'],
  TE:  ['Physical Route Runner','Vertical Threat','Pure Blocker','Possession'],
  OT:  ['Raw Strength','Well Rounded','Pass Protector','Agile'],
  OG:  ['Raw Strength','Well Rounded','Pass Protector','Agile'],
  C:   ['Raw Strength','Well Rounded','Pass Protector','Agile'],
  DE:  ['Speed Rusher','Edge Setter','Power Rusher'],
  DT:  ['Pure Power','Gap Specialist','Speed Rusher','Power Rusher'],
  LB:  ['Lurker','Signal Caller','Thumper'],
  CB:  ['Field','Zone','Bump','Boundary'],
  S:   ['Coverage Specialist','Hybrid','Box'],
};

// ── Button Builders ───────────────────────────────────────────────────────────
function toRows(items, prefix) {
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    const row = new ActionRowBuilder().addComponents(
      items.slice(i, i + 5).map(item =>
        new ButtonBuilder()
          .setCustomId(prefix + item)
          .setLabel(item)
          .setStyle(ButtonStyle.Primary)
      )
    );
    rows.push(row);
  }
  return rows;
}

export function getPositionRows(commandType) {
  return toRows(POSITIONS, commandType + '_pos_');
}

export function getArchetypeRows(commandType, position) {
  return toRows(ARCHETYPES[position] ?? [], commandType + '_arch_' + position + '_');
}

export function getConfirmRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_' + recruitId).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_' + recruitId).setLabel('Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cancel_' + recruitId).setLabel('Cancel').setStyle(ButtonStyle.Danger),
  );
}

export function getDeleteRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clear_yes_' + recruitId).setLabel('Delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('clear_no_' + recruitId).setLabel('Keep').setStyle(ButtonStyle.Secondary),
  );
}

// ── Embed Builders ────────────────────────────────────────────────────────────
export function createAnalysisEmbed(recruit) {
  const attrs = recruit.attributes || {};
  const attrText = Object.entries(attrs)
    .map(([k, v]) => '**' + k + '**: ' + v)
    .join('\n') || 'No attributes found';

  return new EmbedBuilder()
    .setTitle('Recruit: ' + recruit.position + ' - ' + recruit.archetype)
    .setDescription('Review extracted attributes. Confirm to calculate fit score.')
    .addFields({ name: 'Attributes', value: attrText })
    .setColor(0x3498db)
    .setFooter({ text: 'Recruit ID: ' + recruit.id })
    .setTimestamp();
}

export function createBreakdownEmbed(score, breakdown, warning = null) {
  const color = score >= 80 ? 0x2ecc71 : score >= 60 ? 0xf39c12 : 0xe74c3c;
  const icon  = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
  const lines = breakdown.map(b =>
    (b.pass ? '✅' : '❌') + ' **' + b.attr + '**: ' + b.value + ' _(range: ' + b.min + '-' + b.max + ')_'
  ).join('\n') || 'No data';

  const embed = new EmbedBuilder()
    .setTitle(icon + ' Fit Score: ' + score + '%')
    .addFields({ name: 'Attribute Breakdown', value: lines })
    .setColor(color)
    .setTimestamp();

  if (warning) embed.setFooter({ text: 'Warning: ' + warning });
  return embed;
}

export function createConfigEmbed(position, archetype, ranges) {
  const entries = Object.entries(ranges);
  const rangeText = entries.length
    ? entries.map(([k, v]) => '**' + k + '**: ' + v.min + ' - ' + v.max).join('\n')
    : '_No ranges set yet. Click Edit Ranges to add some._';

  return new EmbedBuilder()
    .setTitle('Config: ' + position + ' - ' + archetype)
    .setDescription('Ideal attribute ranges for this archetype:')
    .addFields({ name: 'Ranges (' + entries.length + ' configured)', value: rangeText })
    .setColor(0x9b59b6)
    .setFooter({ text: 'Use Edit Ranges to update' })
    .setTimestamp();
}

export function createRangeSummaryEmbed(position, archetype, ranges) {
  const entries = Object.entries(ranges);
  if (entries.length === 0) {
    return new EmbedBuilder()
      .setTitle('Ranges: ' + position + ' - ' + archetype)
      .setDescription('No ranges configured yet. Use /config to set them up.')
      .setColor(0x95a5a6)
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setTitle('Ranges: ' + position + ' - ' + archetype)
    .setDescription('All configured attribute ranges:')
    .addFields({
      name: entries.length + ' Attributes',
      value: entries.map(([k, v]) => '**' + k + '**: ' + v.min + ' - ' + v.max).join('\n'),
    })
    .setColor(0x2ecc71)
    .setFooter({ text: 'Use /config to edit these ranges' })
    .setTimestamp();
}

// ── Fit Calculator ────────────────────────────────────────────────────────────
export async function calculateFit(position, archetype, attributes) {
  const { data: arch, error } = await supabase
    .from('archetypes')
    .select('ranges')
    .eq('position', position.toUpperCase())
    .eq('archetype', archetype)
    .single();

  if (error || !arch) {
    return { score: 0, breakdown: [], warning: 'No ranges configured for this archetype. Use /config first.' };
  }

  const ranges = arch.ranges || {};
  const breakdown = [];
  let matched = 0, total = 0;

  for (const [attr, value] of Object.entries(attributes)) {
    const range = ranges[attr];
    if (!range) continue;
    total++;
    const inRange = value >= range.min && value <= range.max;
    if (inRange) matched++;
    breakdown.push({ attr, value, min: range.min, max: range.max, pass: inRange });
  }

  const score   = total > 0 ? Math.round((matched / total) * 100) : 0;
  const warning = total === 0 ? 'No configured attributes matched recruit data.' : null;
  return { score, breakdown, warning };
}
