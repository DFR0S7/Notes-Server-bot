import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { supabase } from './supabase.js';
import { performOCR, parseAttributes } from './utils/ocr.js';
import {
  getPositionRows, getArchetypeRows, getConfirmRow, getDeleteRow,
  createAnalysisEmbed, createBreakdownEmbed, createConfigEmbed,
  createRangeSummaryEmbed, createRecruitDetailEmbed, calculateFit,
} from './utils.js';
import { activeEdits, client } from './index.js';

// ── Live Todo List ─────────────────────────────────────────────────────────────
export async function postTodoList(userId) {
  // Get configured channel
  const { data: cfg } = await supabase
    .from('todo_config')
    .select('channel_id')
    .eq('user_id', userId)
    .single();
  if (!cfg?.channel_id) return;

  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) return;

  // Fetch all todos for this user
  const { data: todos } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .order('league')
    .order('id');
  if (!todos?.length) return;

  // Group by league
  const grouped = {};
  for (const row of todos) {
    if (!grouped[row.league]) grouped[row.league] = [];
    grouped[row.league].push(row);
  }

  // Build embeds (max 25 fields each)
  const fields = [];
  for (const [lg, tasks] of Object.entries(grouped)) {
    const done  = tasks.filter(t => t.done).length;
    const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ' ' + t.task).join('\n');
    fields.push({ name: lg + ' (' + done + '/' + tasks.length + ')', value: lines.slice(0, 1024) });
  }

  const embeds = [];
  for (let i = 0; i < fields.length; i += 25) {
    const embed = new EmbedBuilder()
      .setTitle(i === 0 ? '📋 League To-Do List' : '📋 (continued)')
      .setColor(0x5865f2)
      .addFields(fields.slice(i, i + 25));
    if (i === 0) embed.setFooter({ text: 'Updated' }).setTimestamp();
    embeds.push(embed);
  }

  // Wipe previous bot messages and repost
  const messages = await channel.messages.fetch({ limit: 100 });
  const botMessages = messages.filter(m => m.author.id === client.user.id);
  for (const msg of botMessages.values()) {
    await msg.delete().catch(() => null);
  }
  for (const embed of embeds) {
    await channel.send({ embeds: [embed] });
  }
}

// ── Command Handler ───────────────────────────────────────────────────────────
export async function handleCommand(interaction) {
  const { commandName } = interaction;

  // /analyze
  if (commandName === 'analyze') {
    const attachment = interaction.options.getAttachment('screenshot');
    if (!attachment?.contentType?.startsWith('image/')) {
      return interaction.reply({ content: 'Please attach a valid image file.', flags: 64 });
    }
    activeEdits.set(interaction.user.id, { type: 'analyze_pending', attachmentUrl: attachment.url });
    await interaction.reply({ content: 'Step 1: Select a position', components: getPositionRows('analyze'), flags: 64 });
  }

  // /add-archetype
  if (commandName === 'add-archetype') {
    const position  = interaction.options.getString('position').toUpperCase();
    const archetype = interaction.options.getString('archetype').trim();

    const { POSITIONS, ARCHETYPES } = await import('./utils.js');

    if (!POSITIONS.includes(position)) {
      return interaction.reply({ content: 'Unknown position **' + position + '**. Valid positions: ' + POSITIONS.join(', '), flags: 64 });
    }

    // Check Supabase for duplicates instead of in-memory
    const { data: existing } = await supabase
      .from('archetypes')
      .select('id')
      .eq('position', position)
      .eq('archetype', archetype)
      .single();

    if (existing) {
      return interaction.reply({ content: '**' + archetype + '** already exists for **' + position + '**.', flags: 64 });
    }

    // Add to in-memory list
    if (!ARCHETYPES[position]) ARCHETYPES[position] = [];
    ARCHETYPES[position].push(archetype);

    // Save to Supabase
    const { error } = await supabase
      .from('archetypes')
      .insert({ position, archetype, ranges: {} });

    if (error) {
      console.error('Failed to create archetype:', error);
      return interaction.reply({ content: 'Added **' + archetype + '** to **' + position + '** for this session, but failed to save to database.', flags: 64 });
    }

    await interaction.reply({
      content: '✅ Added **' + archetype + '** to **' + position + '**! You can now use `/config` to set ranges and `/analyze` to scout recruits.\n\nNote: the button will appear immediately but resets on bot restart. To make it permanent, add it to `utils.js`.',
      flags: 64,
    });
  }

  // /config
  if (commandName === 'config') {
    await interaction.reply({ content: 'Step 1: Select a position', components: getPositionRows('config'), flags: 64 });
  }

  // /view-config
  if (commandName === 'view-config') {
    await interaction.reply({ content: 'Step 1: Select a position', components: getPositionRows('view'), flags: 64 });
  }

  // /list-recruits
  if (commandName === 'list-recruits') {
    const { data, error } = await supabase
      .from('recruits')
      .select('id, name, position, archetype, fit_score, created_at')
      .eq('user_id', interaction.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data?.length) {
      return interaction.reply({ content: 'No recruits saved yet. Use /analyze to add one!', flags: 64 });
    }

    const lines = data.map(r => {
      const score      = r.fit_score !== null ? r.fit_score + '%' : 'Pending';
      const date       = new Date(r.created_at).toLocaleDateString();
      const recruitName = r.name || 'Unnamed';
      return '`#' + r.id + '` | **' + recruitName + '** | ' + r.position + ' ' + r.archetype + ' | Fit: ' + score + ' | ' + date;
    }).join('\n');

    await interaction.reply({ content: '**Your Recruits (last 20)**\n' + lines + '\n\nUse `/recruit-detail id` to see full attributes.', flags: 64 });
  }

  // /recruit-detail
  if (commandName === 'recruit-detail') {
    const id = interaction.options.getInteger('id');
    const { data, error } = await supabase
      .from('recruits')
      .select('*')
      .eq('id', id)
      .eq('user_id', interaction.user.id)
      .single();

    if (error || !data) {
      return interaction.reply({ content: 'Recruit #' + id + ' not found or does not belong to you.', flags: 64 });
    }

    await interaction.reply({ embeds: [createRecruitDetailEmbed(data)], flags: 64 });
  }

  // /todo-setchannel
  if (commandName === 'todo-setchannel') {
    const channel = interaction.options.getChannel('channel');
    const { error } = await supabase
      .from('todo_config')
      .upsert({ user_id: interaction.user.id, channel_id: channel.id }, { onConflict: 'user_id' });
    if (error) return interaction.reply({ content: 'Failed to save channel. Try again.', flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: `✅ Live todo list will post to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    await postTodoList(interaction.user.id);
    return;
  }

  // /todo-add
  if (commandName === 'todo-add') {
    const league = interaction.options.getString('league').trim();
    const task   = interaction.options.getString('task').trim();
    const { data, error } = await supabase
      .from('todos')
      .insert({ user_id: interaction.user.id, league, task, done: false })
      .select()
      .single();
    if (error) return interaction.reply({ content: 'Failed to add task. Try again.', flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: `✅ Added task **#${data.id}** to **${league}**:\n> ${task}`, flags: MessageFlags.Ephemeral });
    postTodoList(interaction.user.id);
    return;
  }

  // /todo-list - read only embed
  if (commandName === 'todo-list') {
    const league = interaction.options.getString('league');
    let query = supabase.from('todos').select('*').eq('user_id', interaction.user.id).order('league').order('id');
    if (league) query = query.ilike('league', league.trim());
    const { data, error } = await query;
    if (error) return interaction.reply({ content: 'Failed to fetch tasks.', flags: MessageFlags.Ephemeral });
    if (!data.length) return interaction.reply({ content: league ? `No tasks found for **${league}**.` : 'No tasks found.', flags: MessageFlags.Ephemeral });

    const grouped = {};
    for (const row of data) {
      if (!grouped[row.league]) grouped[row.league] = [];
      grouped[row.league].push(row);
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 To-Do List')
      .setColor(0x5865f2)
      .setTimestamp();

    for (const [lg, tasks] of Object.entries(grouped)) {
      const done  = tasks.filter(t => t.done).length;
      const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ' ' + t.task).join('\n');
      embed.addFields({ name: lg + ' (' + done + '/' + tasks.length + ')', value: lines });
    }

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // /todo-edit - interactive embed with buttons
  if (commandName === 'todo-edit') {
    const league = interaction.options.getString('league') || '';
    let query = supabase.from('todos').select('*').eq('user_id', interaction.user.id).order('league').order('id');
    if (league) query = query.ilike('league', league.trim());
    const { data, error } = await query;
    if (error) return interaction.reply({ content: 'Failed to fetch tasks.', flags: MessageFlags.Ephemeral });
    if (!data.length) return interaction.reply({ content: league ? `No tasks found for **${league}**.` : 'No tasks found.', flags: MessageFlags.Ephemeral });

    const grouped = {};
    for (const row of data) {
      if (!grouped[row.league]) grouped[row.league] = [];
      grouped[row.league].push(row);
    }

    const { embed, components } = buildTodoEmbed(grouped, league);
    return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
  }

  // /todo-reset
  if (commandName === 'todo-reset') {
    const league = interaction.options.getString('league').trim();
    const { error } = await supabase
      .from('todos').update({ done: false }).eq('user_id', interaction.user.id).ilike('league', league);
    if (error) return interaction.reply({ content: 'Failed to reset tasks.', flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: `⬜ All tasks in **${league}** have been unchecked.`, flags: MessageFlags.Ephemeral });
    postTodoList(interaction.user.id);
    return;
  }


  if (commandName === 'clear-recruit') {
    const id = interaction.options.getInteger('id');
    const { data } = await supabase
      .from('recruits')
      .select('id, name, position, archetype')
      .eq('id', id)
      .eq('user_id', interaction.user.id)
      .single();

    if (!data) {
      return interaction.reply({ content: 'Recruit #' + id + ' not found or does not belong to you.', flags: 64 });
    }

    const label = (data.name || 'Unnamed') + ' (' + data.position + ' ' + data.archetype + ')';
    await interaction.reply({
      content: 'Delete **#' + id + ' — ' + label + '**? This cannot be undone.',
      components: [getDeleteRow(id)],
      flags: 64,
    });
  }
}

// ── Todo Helpers ──────────────────────────────────────────────────────────────
function buildTodoEmbed(grouped, filter = '') {
  const embed = new EmbedBuilder()
    .setTitle('📋 To-Do List')
    .setColor(0x5865f2)
    .setTimestamp();

  for (const [lg, tasks] of Object.entries(grouped)) {
    const done  = tasks.filter(t => t.done).length;
    const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ' ' + t.task).join('\n');
    embed.addFields({ name: lg + ' (' + done + '/' + tasks.length + ')', value: lines });
  }

  const components = [];
  let row = new ActionRowBuilder();
  let btnCount = 0;
  const f = filter ? '|' + filter : '';

  for (const [lg, tasks] of Object.entries(grouped)) {
    for (const t of tasks) {
      if (btnCount === 5) { components.push(row); row = new ActionRowBuilder(); btnCount = 0; }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('todo_toggle_' + t.id + f)
          .setLabel((t.done ? '☑️ ' : '⬜ ') + t.task.slice(0, 30))
          .setStyle(t.done ? ButtonStyle.Secondary : ButtonStyle.Primary)
      );
      btnCount++;
    }
    if (btnCount === 5) { components.push(row); row = new ActionRowBuilder(); btnCount = 0; }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('todo_reset_' + lg + f)
        .setLabel('↺ Reset ' + lg)
        .setStyle(ButtonStyle.Danger)
    );
    btnCount++;
  }
  if (btnCount > 0) components.push(row);

  return { embed, components };
}

async function refreshTodoMessage(interaction, filter = '') {
  let query = supabase.from('todos').select('*').eq('user_id', interaction.user.id).order('league').order('id');
  if (filter) query = query.ilike('league', filter);
  const { data } = await query;

  const grouped = {};
  for (const row of data || []) {
    if (!grouped[row.league]) grouped[row.league] = [];
    grouped[row.league].push(row);
  }

  const { embed, components } = buildTodoEmbed(grouped, filter);
  await interaction.update({ embeds: [embed], components });
}

// ── Analysis Helper ───────────────────────────────────────────────────────────
async function runAnalysis(interaction, session, position, archetype) {
  const { data: arch } = await supabase
    .from('archetypes')
    .select('ranges')
    .eq('position', position.toUpperCase())
    .eq('archetype', archetype)
    .single();

  const configuredAttrs = arch?.ranges ? Object.keys(arch.ranges) : [];

  if (configuredAttrs.length === 0) {
    return interaction.editReply({
      content: 'No ranges configured for **' + position + ' ' + archetype + '**.\nPlease run `/config` first to set up attribute ranges before analyzing.',
      components: [],
    });
  }

  let ocrText, recruitName = null;
  try {
    const ocrResult = await performOCR(session.attachmentUrl);
    ocrText     = ocrResult.text;
    recruitName = ocrResult.name;
  } catch (err) {
    console.error('OCR failed:', err);
    activeEdits.delete(interaction.user.id);
    return interaction.editReply({ content: 'OCR failed. Try a clearer screenshot and run /analyze again.' });
  }

  const attributes = parseAttributes(ocrText, configuredAttrs);
  activeEdits.delete(interaction.user.id);

  if (Object.keys(attributes).length === 0) {
    return interaction.editReply({ content: 'No ratings found. Make sure the screenshot clearly shows attribute numbers.' });
  }

  const { data: recruit, error } = await supabase
    .from('recruits')
    .insert({ user_id: interaction.user.id, position: position.toUpperCase(), archetype, attributes, name: recruitName, status: 'pending' })
    .select()
    .single();

  if (error) return interaction.editReply({ content: 'Failed to save recruit. Try again.' });

  const foundCount = Object.keys(attributes).length;
  const missing    = configuredAttrs.filter(a => !(a in attributes));

  if (missing.length > 0) {
    activeEdits.set(interaction.user.id, { type: 'filling_missing', id: recruit.id, missing, filled: 0, hasName: !!recruitName });
    return interaction.editReply({
      content: 'Found **' + foundCount + '/10** attributes' + (recruitName ? ' for **' + recruitName + '**' : '') + '.\n\nWhat is the value for **' + missing[0] + '**? (or type `skip` to leave it out)',
      embeds: [createAnalysisEmbed(recruit)],
      components: [],
    });
  } else if (recruitName) {
    activeEdits.set(interaction.user.id, { type: 'analyze_confirm', id: recruit.id });
    return interaction.editReply({
      content: 'Found **10/10** attributes for **' + recruitName + '** ✅\n\nConfirm to calculate fit score:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruit.id)],
    });
  } else {
    activeEdits.set(interaction.user.id, { type: 'naming', id: recruit.id });
    return interaction.editReply({
      content: 'Found **10/10** attributes ✅\n\nReply with the **recruit\'s name** (or type `skip` to leave unnamed):',
      embeds: [createAnalysisEmbed(recruit)],
      components: [],
    });
  }
}

// ── Button Handler ────────────────────────────────────────────────────────────
export async function handleButton(interaction) {
  const id = interaction.customId;

  // todo_toggle_{id} or todo_toggle_{id}|{filter}
  if (id.startsWith('todo_toggle_')) {
    const rest   = id.replace('todo_toggle_', '');
    const [taskIdStr, filter = ''] = rest.split('|');
    const taskId = parseInt(taskIdStr);
    const { data: task, error: fetchErr } = await supabase
      .from('todos').select('*').eq('id', taskId).eq('user_id', interaction.user.id).single();
    if (fetchErr || !task) return interaction.reply({ content: 'Task not found.', flags: MessageFlags.Ephemeral });
    await supabase.from('todos').update({ done: !task.done }).eq('id', taskId);
    await refreshTodoMessage(interaction, filter);
    postTodoList(interaction.user.id);
    return;
  }

  // todo_reset_{league} or todo_reset_{league}|{filter}
  if (id.startsWith('todo_reset_')) {
    const rest   = id.replace('todo_reset_', '');
    const pipeIdx = rest.indexOf('|');
    const league = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
    const filter = pipeIdx === -1 ? '' : rest.slice(pipeIdx + 1);
    await supabase.from('todos').update({ done: false }).eq('user_id', interaction.user.id).eq('league', league);
    await refreshTodoMessage(interaction, filter);
    postTodoList(interaction.user.id);
    return;
  }


  if (id.startsWith('analyze_pos_')) {
    const position = id.replace('analyze_pos_', '');
    const session  = activeEdits.get(interaction.user.id);
    if (!session?.attachmentUrl) {
      return interaction.update({ content: 'Session expired. Please run /analyze again.', components: [] });
    }
    activeEdits.set(interaction.user.id, { ...session, position });
    await interaction.update({
      content: 'Position: **' + position + '**\nStep 2: Select an archetype',
      components: await getArchetypeRows('analyze', position),
    });
  }

  // analyze_arch_{POSITION}_{ARCHETYPE}
  if (id.startsWith('analyze_arch_')) {
    const rest      = id.replace('analyze_arch_', '');
    const idx       = rest.indexOf('_');
    const position  = rest.substring(0, idx);
    const archetype = rest.substring(idx + 1);
    const session   = activeEdits.get(interaction.user.id);

    if (!session?.attachmentUrl) {
      return interaction.update({ content: 'Session expired. Please run /analyze again.', components: [] });
    }

    await interaction.update({ content: 'Running OCR — this may take up to 1 minute...', components: [] });
    return runAnalysis(interaction, session, position, archetype);
  }

  // config_pos_{POSITION}
  if (id.startsWith('config_pos_')) {
    const position = id.replace('config_pos_', '');
    await interaction.update({
      content: 'Position: **' + position + '**\nStep 2: Select an archetype',
      components: await getArchetypeRows('config', position),
    });
  }

  // config_arch_{POSITION}_{ARCHETYPE}
  if (id.startsWith('config_arch_')) {
    const rest      = id.replace('config_arch_', '');
    const idx       = rest.indexOf('_');
    const position  = rest.substring(0, idx);
    const archetype = rest.substring(idx + 1);

    let { data: arch } = await supabase
      .from('archetypes').select('ranges')
      .eq('position', position.toUpperCase()).eq('archetype', archetype).single();

    if (!arch) {
      await supabase.from('archetypes').insert({ position: position.toUpperCase(), archetype, ranges: {} });
      arch = { ranges: {} };
    }

    const editRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('config_edit_' + position + '_' + archetype)
        .setLabel('Edit Ranges')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.update({ content: '', embeds: [createConfigEmbed(position, archetype, arch.ranges)], components: [editRow] });
  }

  // view_pos_{POSITION}
  if (id.startsWith('view_pos_')) {
    const position = id.replace('view_pos_', '');
    await interaction.update({
      content: 'Position: **' + position + '**\nStep 2: Select an archetype',
      components: await getArchetypeRows('view', position),
    });
  }

  // view_arch_{POSITION}_{ARCHETYPE}
  if (id.startsWith('view_arch_')) {
    const rest      = id.replace('view_arch_', '');
    const idx       = rest.indexOf('_');
    const position  = rest.substring(0, idx);
    const archetype = rest.substring(idx + 1);

    const { data: arch } = await supabase
      .from('archetypes').select('ranges')
      .eq('position', position.toUpperCase()).eq('archetype', archetype).single();

    await interaction.update({
      content: '',
      embeds: [createRangeSummaryEmbed(position, archetype, arch?.ranges ?? {})],
      components: [],
    });
  }

  // confirm_{id}
  if (id.startsWith('confirm_')) {
    const recruitId = parseInt(id.replace('confirm_', ''));
    await interaction.deferUpdate();

    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', recruitId).single();
    if (!recruit) return interaction.editReply({ content: 'Recruit not found.', components: [] });

    const { score, breakdown, warning } = await calculateFit(recruit.position, recruit.archetype, recruit.attributes);
    await supabase.from('recruits').update({ fit_score: score, status: 'confirmed' }).eq('id', recruitId);

    await interaction.editReply({
      content: 'Saved! Fit Score: **' + score + '%**',
      embeds: [createBreakdownEmbed(recruit, score, breakdown, warning)],
      components: [],
    });
  }

  // edit_{id} — label correction mode
  if (id.startsWith('edit_') && !id.startsWith('edit_ranges')) {
    const recruitId = parseInt(id.replace('edit_', ''));
    activeEdits.set(interaction.user.id, { type: 'recruit', id: recruitId });
    await interaction.reply({
      content: 'Edit Mode - two commands available:\n• **Add/update value**: `ATTR: 66` (e.g. `TOR: 66`)\n• **Rename label**: `WRONG: CORRECT` (e.g. `TAK: CTH`)\n\nType `done` to finish or `cancel` to quit.',
      flags: 64,
    });
  }

  // cancel_{id}
  if (id.startsWith('cancel_')) {
    const recruitId = parseInt(id.replace('cancel_', ''));
    await supabase.from('recruits').delete().eq('id', recruitId);
    await interaction.update({ content: 'Recruit cancelled and removed.', components: [], embeds: [] });
  }

  // config_edit_{position}_{archetype}
  if (id.startsWith('config_edit_')) {
    const rest      = id.replace('config_edit_', '');
    const idx       = rest.indexOf('_');
    const position  = rest.substring(0, idx);
    const archetype = rest.substring(idx + 1);

    activeEdits.set(interaction.user.id, { type: 'config', position, archetype });
    await interaction.reply({
      content: 'Range Edit Mode - paste all ranges at once, one per line:\nExample:\nSpeed 82 95\nThrow Power 88 99\n\nType "done" when finished to see full summary.',
      flags: 64,
    });
  }

  // clear_yes_{id}
  if (id.startsWith('clear_yes_')) {
    const recruitId = parseInt(id.replace('clear_yes_', ''));
    await supabase.from('recruits').delete().eq('id', recruitId);
    await interaction.update({ content: 'Recruit #' + recruitId + ' deleted.', components: [] });
  }

  // clear_no_{id}
  if (id.startsWith('clear_no_')) {
    await interaction.update({ content: 'Cancelled. No changes made.', components: [] });
  }
}

// ── Message Handler ───────────────────────────────────────────────────────────
export async function handleMessage(message) {
  if (message.author.bot) return;

  const session = activeEdits.get(message.author.id);
  if (!session) return;

  const text = message.content.trim();

  // ── Fill missing attributes ────────────────────────────────────────────────
  if (session.type === 'filling_missing') {
    const { id, missing, filled } = session;
    const attr = missing[filled];

    if (text.toLowerCase() !== 'skip') {
      const val = parseInt(text);
      if (isNaN(val) || val < 1 || val > 99) {
        return message.reply('Please enter a valid number (1-99) for **' + attr + '**, or type `skip`:');
      }
      // Fetch current attributes and add the new value
      const { data: recruit } = await supabase.from('recruits').select('attributes').eq('id', id).single();
      const updated = { ...recruit.attributes, [attr]: val };
      await supabase.from('recruits').update({ attributes: updated }).eq('id', id);
    }

    const nextFilled = filled + 1;
    if (nextFilled < missing.length) {
      activeEdits.set(message.author.id, { type: 'filling_missing', id, missing, filled: nextFilled, hasName: session.hasName });
      return message.reply('What is the value for **' + missing[nextFilled] + '**? (or type `skip` to leave it out)');
    }

    // All attrs done — go to name or confirm
    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', id).single();
    if (session.hasName) {
      activeEdits.set(message.author.id, { type: 'analyze_confirm', id });
      return message.reply({
        content: 'Got it! Confirm to calculate fit score:',
        embeds: [createAnalysisEmbed(recruit)],
        components: [getConfirmRow(id)],
      });
    }
    activeEdits.set(message.author.id, { type: 'naming', id });
    return message.reply({
      content: 'Got it! Reply with the **recruit\'s name** (or type `skip` to leave unnamed):',
      embeds: [createAnalysisEmbed(recruit)],
      components: [],
    });
  }

  // ── Naming session ─────────────────────────────────────────────────────────
  if (session.type === 'naming') {
    const name = text.toLowerCase() === 'skip' ? null : text;
    if (name) await supabase.from('recruits').update({ name }).eq('id', session.id);

    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', session.id).single();
    activeEdits.delete(message.author.id);

    return message.reply({
      content: (name ? 'Name set to **' + name + '**! ' : '') + 'Confirm to calculate fit score:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(session.id)],
    });
  }

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
        content: 'Labels updated! Confirm to calculate fit score:',
        embeds: [createAnalysisEmbed(recruit)],
        components: [getConfirmRow(session.id)],
      });
    }

    if (session.type === 'config') {
      const { data: arch } = await supabase
        .from('archetypes').select('ranges')
        .eq('position', session.position).eq('archetype', session.archetype).single();
      return message.reply({
        content: 'All ranges saved for **' + session.position + ' - ' + session.archetype + '**!',
        embeds: [createRangeSummaryEmbed(session.position, session.archetype, arch?.ranges ?? {})],
      });
    }
  }

  // recruit edit: "WRONG: CORRECT" to rename, or "ATTR: 66" to add/update value
  if (session.type === 'recruit') {
    const match = text.match(/^(.+?):\s*(.+)$/);
    if (!match) return message.react('❓');

    const left  = match[1].trim();
    const right = match[2].trim();

    const { data } = await supabase.from('recruits').select('attributes').eq('id', session.id).single();
    const attrs = { ...data.attributes };

    // If right side is a number — add or update value
    if (/^\d+$/.test(right)) {
      const value = parseInt(right);
      if (value < 1 || value > 99) return message.reply('Value must be between 1 and 99.');
      attrs[left] = value;
      await supabase.from('recruits').update({ attributes: attrs }).eq('id', session.id);
      return message.reply('Set **' + left + '** to **' + value + '**');
    }

    // Otherwise treat as rename: left = old label, right = new label
    if (!(left in attrs)) {
      return message.reply('Could not find **' + left + '**. Check the abbreviation matches exactly.');
    }
    const value = attrs[left];
    delete attrs[left];
    attrs[right] = value;
    await supabase.from('recruits').update({ attributes: attrs }).eq('id', session.id);
    return message.reply('Renamed **' + left + '** → **' + right + '** (value: ' + value + ')');
  }

  // config range edit: all at once
  if (session.type === 'config') {
    const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
    const updates = {};
    const errors  = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) { errors.push('Could not parse: ' + line); continue; }

      const min  = parseInt(parts[parts.length - 2]);
      const max  = parseInt(parts[parts.length - 1]);
      const attr = parts.slice(0, parts.length - 2).join(' ');

      if (isNaN(min) || isNaN(max) || min >= max) {
        errors.push('Invalid range for: ' + line);
        continue;
      }
      updates[attr] = { min, max };
    }

    if (Object.keys(updates).length === 0) {
      return message.reply('No valid ranges found. Format: AttributeName min max (e.g. Speed 85 95)');
    }

    const { data: arch } = await supabase
      .from('archetypes').select('ranges')
      .eq('position', session.position).eq('archetype', session.archetype).single();

    const ranges = { ...arch.ranges, ...updates };
    await supabase.from('archetypes')
      .update({ ranges })
      .eq('position', session.position).eq('archetype', session.archetype);

    const saved = Object.entries(updates).map(([a, { min, max }]) => '**' + a + '**: ' + min + ' - ' + max).join('\n');
    let reply = 'Saved **' + Object.keys(updates).length + '** ranges:\n' + saved;
    if (errors.length) reply += '\n\nSkipped:\n' + errors.join('\n');
    reply += '\n\nType more ranges or **done** to finish and see full summary.';
    return message.reply(reply);
  }
}
