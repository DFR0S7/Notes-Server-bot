import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

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

// Split array into rows of max 5
function toRows(items, prefix) {
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    const chunk = items.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      chunk.map(item =>
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
  const archetypes = ARCHETYPES[position] ?? [];
  return toRows(archetypes, commandType + '_arch_' + position + '_');
}

export function getConfirmRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confirm_' + recruitId)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('edit_' + recruitId)
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('cancel_' + recruitId)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

export function getDeleteRow(recruitId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('clear_yes_' + recruitId)
      .setLabel('Delete')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('clear_no_' + recruitId)
      .setLabel('Keep')
      .setStyle(ButtonStyle.Secondary),
  );
}
