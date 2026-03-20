import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { supabase } from './supabase.js';

// ── CFB26 Positions & Archetypes ─────────────────────────────────────────────
export const POSITIONS = ['QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S','ATH'];

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
  ATH: [],
};

// ── Attribute Display Order ───────────────────────────────────────────────────
const QB_ORDER   = ['AWR','TOR','THP','TUP','SAC','BSK','MAC','SPD','DAC','ACC'];
const HB_ORDER   = ['AWR','COD','SPD','JKM','ACC','SPM','CAR','BCV','BTK','CTH'];
const CB_ORDER   = ['AWR','MCV','SPD','ZCV','ACC','PRS','COD','CTH','AGI','TAK'];
const S_ORDER    = ['AWR','MCV','SPD','ZCV','ACC','PRS','COD','CTH','AGI','TAK'];
const LB_ORDER   = ['AWR','TAK','SPD','HPW','ACC','PUR','STR','MCV','PRC','ZCV'];
const DE_ORDER   = ['AWR','HPW','STR','PMV','ACC','FMV','BSH','SPD','TAK','PUR'];
const DT_ORDER   = ['AWR','HPW','STR','PMV','ACC','FMV','BSH','SPD','TAK','PUR'];
const OL_ORDER   = ['AWR','PBP','RBK','PBF','RBP','IBL','RBF','AGI','PBK','STR'];
const TE_DEFAULT = ['AWR','PBK','SPD','CTH','STR','CIT','ACC','SRR','RBK','MRR'];
const TE_VERT    = ['AWR','PBK','SPD','CTH','STR','CIT','ACC','MRR','RBK','DRR'];
const WR_GADGET  = ['AWR','SPC','SPD','SRR','ACC','MRR','CTH','DRR','CIT','THP'];
const WR_DEFAULT = ['AWR','SPC','SPD','SRR','ACC','MRR','CTH','DRR','CIT','RLS'];
const WR_AGILE   = ['AWR','SPC','SPD','SRR','ACC','MRR','CTH','DRR','CIT','AGI'];
const WR_GRITTY  = ['AWR','SPC','SPD','SRR','ACC','MRR','CTH','DRR','CIT','RBK'];

export function getAttributeOrder(position, archetype) {
  switch (position) {
    case 'QB':  return QB_ORDER;
    case 'HB':  return HB_ORDER;
    case 'CB':  return CB_ORDER;
    case 'S':   return S_ORDER;
    case 'LB':  return LB_ORDER;
    case 'DE':  return DE_ORDER;
    case 'DT':  return DT_ORDER;
    case 'OT':
    case 'OG':
    case 'C':   return OL_ORDER;
    case 'TE':
      return archetype === 'Vertical Threat' ? TE_VERT : TE_DEFAULT;
    case 'WR':
      if (archetype === 'Gadget')                                                return WR_GADGET;
      if (archetype === 'Route Artist' || archetype === 'Elusive Route Runner') return WR_AGILE;
      if (archetype === 'Gritty Possession')                                     return WR_GRITTY;
      return WR_DEFAULT;
    case 'ATH':
      if (archetype === 'Thumper' || archetype === 'Signal Caller') return LB_ORDER;
      if (archetype === 'Power Rusher') return DE_ORDER;
      if (archetype === 'Dual Threat')   return QB_ORDER;
      // HB-style ATH archetypes
      return HB_ORDER;
    default: return null;
  }
}


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

export async function getArchetypeRows(commandType, position) {
  const inMemory = ARCHETYPES[position] ?? [];
  const { data } = await supabase
    .from('archetypes')
    .select('archetype')
    .eq('position', position.toUpperCase());
  const fromDb = (data || []).map(r => r.archetype);
  // Merge: DB is source of truth, in-memory fills any gaps not yet in DB
  const merged = [...new Set([...fromDb, ...inMemory])];
  return toRows(merged, commandType + '_arch_' + position + '_');
}

export function getConfirmRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_' + recruitId).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_' + recruitId).setLabel('Edit Labels').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cancel_' + recruitId).setLabel('Cancel').setStyle(ButtonStyle.Danger),
  );
}

export function getKeepDumpRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('keep_' + recruitId).setLabel('✅ Keep').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dump_' + recruitId).setLabel('🗑️ Dump').setStyle(ButtonStyle.Danger),
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
  const order = getAttributeOrder(recruit.position, recruit.archetype);
  const sorted = order
    ? order.filter(k => k in attrs).map(k => [k, attrs[k]])
    : Object.entries(attrs);
  const attrText = sorted.map(([k, v]) => '**' + k + '**: ' + v).join('\n') || 'No attributes found';

  const title = recruit.name
    ? recruit.name + ' | ' + recruit.position + ' - ' + recruit.archetype
    : 'Recruit: ' + recruit.position + ' - ' + recruit.archetype;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription('Review extracted attributes. Confirm to calculate fit score.')
    .addFields({ name: 'Attributes', value: attrText })
    .setColor(0x3498db)
    .setFooter({ text: 'Recruit ID: ' + recruit.id })
    .setTimestamp();
}

export function createBreakdownEmbed(recruit, score, breakdown, warning = null) {
  const color     = score >= 80 ? 0x2ecc71 : score >= 60 ? 0xf39c12 : 0xe74c3c;
  const scoreIcon = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
  const order = getAttributeOrder(recruit?.position, recruit?.archetype);
  const sorted = order
    ? [...breakdown].sort((a, b) => {
        const ai = order.indexOf(a.attr);
        const bi = order.indexOf(b.attr);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      })
    : breakdown;
  const lines = sorted.map(b => {
    const icon = b.above ? '⬆️' : b.pass ? '✅' : '❌';
    return icon + ' **' + b.attr + '**: ' + b.value + ' _(range: ' + b.min + '-' + b.max + ')_';
  }).join('\n') || 'No data';

  const title = recruit?.name
    ? scoreIcon + ' ' + recruit.name + ' — Fit Score: ' + score + '%'
    : scoreIcon + ' Fit Score: ' + score + '%';

  const embed = new EmbedBuilder()
    .setTitle(title)
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

  const order = getAttributeOrder(position, archetype);
  const sortedEntries = order
    ? order.filter(k => k in ranges).map(k => [k, ranges[k]])
    : entries;

  return new EmbedBuilder()
    .setTitle('Ranges: ' + position + ' - ' + archetype)
    .setDescription('All configured attribute ranges:')
    .addFields({
      name: entries.length + ' Attributes',
      value: sortedEntries.map(([k, v]) => '**' + k + '**: ' + v.min + ' - ' + v.max).join('\n'),
    })
    .setColor(0x2ecc71)
    .setFooter({ text: 'Use /config to edit these ranges' })
    .setTimestamp();
}

export function createRecruitDetailEmbed(recruit) {
  const attrs = recruit.attributes || {};
  const order = getAttributeOrder(recruit.position, recruit.archetype);
  const sorted = order
    ? order.filter(k => k in attrs).map(k => [k, attrs[k]])
    : Object.entries(attrs);
  const attrText = sorted.map(([k, v]) => '**' + k + '**: ' + v).join('\n') || 'No attributes found';

  const score = recruit.fit_score !== null ? recruit.fit_score + '%' : 'Not calculated';
  const name  = recruit.name || 'Unnamed';
  const date  = new Date(recruit.created_at).toLocaleDateString();

  return new EmbedBuilder()
    .setTitle(name + ' | ' + recruit.position + ' - ' + recruit.archetype)
    .addFields(
      { name: 'Fit Score', value: score, inline: true },
      { name: 'Scouted', value: date, inline: true },
      { name: 'Attributes', value: attrText },
    )
    .setColor(0x3498db)
    .setFooter({ text: 'Recruit ID: ' + recruit.id })
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
    const above   = value > range.max;
    if (inRange || above) matched++;
    breakdown.push({ attr, value, min: range.min, max: range.max, pass: inRange, above });
  }

  const score   = total > 0 ? Math.round((matched / total) * 100) : 0;
  const warning = total === 0 ? 'No configured attributes matched recruit data.' : null;
  return { score, breakdown, warning };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Starter item types — seeded on first /shortlist run per user
export const SHORTLIST_STARTER_TYPES = [
  { name: 'Advance',    icon: '⏰', is_advance: true  },
  { name: 'Game',       icon: '🏈', is_advance: false },
  { name: 'Recruiting', icon: '🎯', is_advance: false },
  { name: 'Other',      icon: '📋', is_advance: false },
];

// Priority colour based on which items are active for a guild row
// 🔴 if Advance is on, 🟡 if any other item on, 🟢 if all clear
export function shortlistRowColor(guildItems, allTypes) {
  const visible = guildItems.filter(i => i.state !== 'off');
  if (!visible.length) return '';

  const advanceItem = visible.find(i => {
    const def = allTypes.find(t => t.id === i.type_id);
    return def?.is_advance;
  });
  const advanceActive = advanceItem?.state === 'active';

  // 🟢 — advance is active AND everything else is done/paused (ready to push)
  if (advanceActive) {
    const othersReady = visible
      .filter(i => i !== advanceItem)
      .every(i => i.state === 'done' || i.state === 'paused' || i.state === 'off');
    if (othersReady) return '🟢';
  }

  // 🔵 — items still in progress (active or done but advance not ready yet)
  const hasActive = visible.some(i => i.state === 'active' || i.state === 'done');
  if (hasActive) return '🔵';

  const anyPaused = visible.some(i => i.state === 'paused');
  if (anyPaused) return '⏸️';
  return '';  // all clear
}

// Build the display string for one guild row
// e.g. "🔴 CFB Dynasty   ⏰ 🔄 🎯"
export function shortlistRowText(rank, guildName, guildItems, allTypes, advanceTime) {
  const color = shortlistRowColor(guildItems, allTypes);

  // Off items are hidden entirely — only show active, done, paused
  const activeIcons = allTypes
    .filter(t => guildItems.find(gi => gi.type_id === t.id && gi.state === 'active'))
    .map(t => t.icon).join(' ');
  const doneIcons = allTypes
    .filter(t => guildItems.find(gi => gi.type_id === t.id && gi.state === 'done'))
    .map(t => `✅${t.icon}`).join(' ');
  const pausedIcons = allTypes
    .filter(t => guildItems.find(gi => gi.type_id === t.id && gi.state === 'paused'))
    .map(t => `⏸️${t.icon}`).join(' ');

  const parts = [activeIcons, doneIcons, pausedIcons].filter(Boolean).join('  ');
  const status = parts || '';
  const timeTag = advanceTime ? `  ·  ${advanceTime}` : '';
  const colorTag = color ? `${color} ` : '';
  return `${rank}. ${colorTag}**${guildName}**　${status}${timeTag}`.trimEnd();
}
