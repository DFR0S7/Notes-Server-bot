import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
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
    const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ` \`#${t.id}\` ${t.task}`).join('\n');
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

    await interaction.reply({ content: '📸 Reading screenshot...', flags: 64 });

    let ocrText = null, ocrName = null, ocrPosition = null, ocrArchetype = null;
    try {
      await interaction.editReply({ content: '🔍 Scanning attributes...' });
      const quick = await performOCR(attachment.url);
      ocrText      = quick.text;
      ocrName      = quick.name;
      ocrPosition  = quick.position;
      ocrArchetype = quick.archetype;
      await interaction.editReply({ content: '✅ Scan complete!' });
    } catch {
      await interaction.editReply({ content: '⚠️ Scan failed — you can still pick position manually.' });
    }

    activeEdits.set(interaction.user.id, {
      type: 'analyze_pending',
      attachmentUrl: attachment.url,
      ocrText,
      ocrName,
      ocrPosition,
      ocrArchetype,
    });

    if (ocrPosition && ocrArchetype) {
      const { data: arch } = await supabase
        .from('archetypes').select('ranges')
        .eq('position', ocrPosition).eq('archetype', ocrArchetype).single();

      if (arch?.ranges && Object.keys(arch.ranges).length > 0) {
        return interaction.editReply({
          content: 'Detected **' + ocrPosition + ' — ' + ocrArchetype + '**. Confirm to proceed or pick manually:',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('analyze_confirm_auto').setLabel('✅ Looks right').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('analyze_pick_manual').setLabel('Pick manually').setStyle(ButtonStyle.Secondary),
            )
          ],
        });
      }
    }

    return interaction.editReply({ content: 'Step 1: Select a position', components: getPositionRows('analyze') });
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

  // /todo-add (bulk: comma-separated tasks)
  if (commandName === 'todo-add') {
    const league = interaction.options.getString('league').trim().toLowerCase();
    const raw    = interaction.options.getString('task').trim();
    const tasks  = raw.split(',').map(t => t.trim()).filter(Boolean);

    const rows = tasks.map(task => ({ user_id: interaction.user.id, league, task, done: false }));
    const { data, error } = await supabase.from('todos').insert(rows).select();
    if (error) return interaction.reply({ content: 'Failed to add tasks. Try again.', flags: MessageFlags.Ephemeral });

    const added = data.map(d => `> \`#${d.id}\` ${d.task}`).join('\n');
    await interaction.reply({
      content: `✅ Added **${data.length}** task${data.length > 1 ? 's' : ''} to **${league}**:\n${added}`,
      flags: MessageFlags.Ephemeral,
    });
    postTodoList(interaction.user.id);
    return;
  }

  // /todo-list - read only embed
  if (commandName === 'todo-list') {
    const league = interaction.options.getString('league')?.trim().toLowerCase() || null;
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
      const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ` \`#${t.id}\` ${t.task}`).join('\n');
      embed.addFields({ name: lg + ' (' + done + '/' + tasks.length + ')', value: lines.slice(0, 1024) });
    }

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // /todo-update - interactive embed with toggle buttons and save
  if (commandName === 'todo-update') {
    const league = interaction.options.getString('league')?.trim().toLowerCase() || '';
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

  // /todo-change
  if (commandName === 'todo-change') {
    const id     = interaction.options.getInteger('id');
    const action = interaction.options.getString('action');
    const newTask = interaction.options.getString('task')?.trim();

    const { data: task, error: fetchErr } = await supabase
      .from('todos').select('*').eq('id', id).eq('user_id', interaction.user.id).single();
    if (fetchErr || !task) return interaction.reply({ content: `No task found with ID **#${id}**.`, flags: MessageFlags.Ephemeral });

    if (action === 'delete') {
      const { error } = await supabase.from('todos').delete().eq('id', id);
      if (error) return interaction.reply({ content: 'Failed to delete task. Try again.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `🗑️ Deleted task **#${id}**: *${task.task}*`, flags: MessageFlags.Ephemeral });
    } else if (action === 'rename') {
      if (!newTask) return interaction.reply({ content: 'Please provide a new task name.', flags: MessageFlags.Ephemeral });
      const { error } = await supabase.from('todos').update({ task: newTask }).eq('id', id).eq('user_id', interaction.user.id);
      if (error) return interaction.reply({ content: 'Failed to rename task. Try again.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `✏️ Task **#${id}** renamed to: *${newTask}*`, flags: MessageFlags.Ephemeral });
    }

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
    const lines = tasks.map(t => (t.done ? '☑️' : '⬜') + ` \`#${t.id}\` ${t.task}`).join('\n');
    embed.addFields({ name: lg + ' (' + done + '/' + tasks.length + ')', value: lines.slice(0, 1024) });
  }

  const components = [];
  let row = new ActionRowBuilder();
  let btnCount = 0;
  let totalBtns = 0;
  const f = filter ? '|' + filter : '';
  const MAX_BTNS = 19; // reserve 1 slot per row-of-5 for the Save button (4 rows × 5 = 20, minus Save = 19)

  for (const [, tasks] of Object.entries(grouped)) {
    for (const t of tasks) {
      if (totalBtns >= MAX_BTNS) break;
      if (btnCount === 5) { components.push(row); row = new ActionRowBuilder(); btnCount = 0; }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('todo_toggle_' + t.id + f)
          .setLabel((t.done ? '☑️ ' : '⬜ ') + t.task.slice(0, 30))
          .setStyle(t.done ? ButtonStyle.Secondary : ButtonStyle.Primary)
      );
      btnCount++;
      totalBtns++;
    }
    if (totalBtns >= MAX_BTNS) break;
  }

  // Save button
  if (btnCount === 5) { components.push(row); row = new ActionRowBuilder(); }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('todo_save' + f)
      .setLabel('💾 Save')
      .setStyle(ButtonStyle.Success)
  );
  components.push(row);

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

// ── Missing Attr Button Row ───────────────────────────────────────────────────
function getMissingAttrRow(recruitId, attr) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('fill_attr_' + recruitId + '_' + attr)
      .setLabel('Enter ' + attr)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('skip_attr_' + recruitId + '_' + attr)
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary),
  );
}


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
    if (session.ocrText) {
      ocrText     = session.ocrText;
      recruitName = session.ocrName ?? null;
      await interaction.editReply({ content: '📊 Parsing attributes...' });
    } else {
      await interaction.editReply({ content: '🔍 Scanning attributes...' });
      const ocrResult = await performOCR(session.attachmentUrl);
      ocrText     = ocrResult.text;
      recruitName = ocrResult.name;
      await interaction.editReply({ content: '📊 Parsing attributes...' });
    }
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
    const missingList = missing.map(a => '`' + a + '`').join(', ');
    return interaction.editReply({
      content: '📋 Found **' + foundCount + '/' + configuredAttrs.length + '** attributes' + (recruitName ? ' for **' + recruitName + '**' : '') + '.\n\nMissing: ' + missingList + '\n\nClick below to enter the first missing value:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getMissingAttrRow(recruit.id, missing[0])],
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
    return;
  }

  // todo_save — save and update live channel
  if (id.startsWith('todo_save')) {
    const filter = id.includes('|') ? id.split('|')[1] : '';
    await refreshTodoMessage(interaction, filter);
    postTodoList(interaction.user.id);
    return;
  }

  // analyze_confirm_auto
  if (id === 'analyze_confirm_auto') {
    const session = activeEdits.get(interaction.user.id);
    if (!session?.attachmentUrl) return interaction.update({ content: 'Session expired. Please run /analyze again.', components: [] });
    await interaction.update({ content: 'Running OCR — this may take up to 1 minute...', components: [] });
    return runAnalysis(interaction, session, session.ocrPosition, session.ocrArchetype);
  }

  // analyze_pick_manual
  if (id === 'analyze_pick_manual') {
    return interaction.update({ content: 'Step 1: Select a position', components: getPositionRows('analyze') });
  }

  // fill_attr_{recruitId}_{attr} — open modal
  if (id.startsWith('fill_attr_')) {
    const parts     = id.replace('fill_attr_', '').split('_');
    const recruitId = parts[0];
    const attr      = parts.slice(1).join('_');

    const modal = new ModalBuilder()
      .setCustomId('modal_fill_' + recruitId + '_' + attr)
      .setTitle('Enter value for ' + attr);

    const input = new TextInputBuilder()
      .setCustomId('attr_value')
      .setLabel('Value for ' + attr + ' (50–99)')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(2)
      .setPlaceholder('e.g. 91')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // skip_attr_{recruitId}_{attr} — skip this attribute
  if (id.startsWith('skip_attr_')) {
    const parts     = id.replace('skip_attr_', '').split('_');
    const recruitId = parseInt(parts[0]);
    const attr      = parts.slice(1).join('_');
    return advanceMissingFill(interaction, recruitId, attr, null);
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

// ── Shared helper: advance through missing attrs after modal or skip ──────────
async function advanceMissingFill(interaction, recruitId, attr, value) {
  const session = activeEdits.get(interaction.user.id);
  if (!session || session.type !== 'filling_missing') {
    return interaction.reply({ content: 'Session expired. Please run /analyze again.', flags: 64 });
  }

  // Save value if provided
  if (value !== null) {
    const { data: recruit } = await supabase.from('recruits').select('attributes').eq('id', recruitId).single();
    const updated = { ...recruit.attributes, [attr]: value };
    await supabase.from('recruits').update({ attributes: updated }).eq('id', recruitId);
  }

  const nextFilled = session.filled + 1;

  if (nextFilled < session.missing.length) {
    activeEdits.set(interaction.user.id, { ...session, filled: nextFilled });
    const nextAttr = session.missing[nextFilled];
    const remaining = session.missing.length - nextFilled;
    return interaction.update({
      content: (value !== null ? '✅ **' + attr + '** set to **' + value + '**.\n\n' : '⏭️ Skipped **' + attr + '**.\n\n') +
        '**' + remaining + '** attribute' + (remaining > 1 ? 's' : '') + ' remaining. Enter value for **' + nextAttr + '**:',
      components: [getMissingAttrRow(recruitId, nextAttr)],
    });
  }

  // All done — go to name or confirm
  const { data: recruit } = await supabase.from('recruits').select('*').eq('id', recruitId).single();
  if (session.hasName) {
    activeEdits.set(interaction.user.id, { type: 'analyze_confirm', id: recruitId });
    return interaction.update({
      content: '✅ All attributes filled! Confirm to calculate fit score:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruitId)],
    });
  }
  activeEdits.set(interaction.user.id, { type: 'naming', id: recruitId });
  return interaction.update({
    content: '✅ All attributes filled! Reply with the **recruit\'s name** (or type `skip` to leave unnamed):',
    embeds: [createAnalysisEmbed(recruit)],
    components: [],
  });
}

// ── Modal Handler ─────────────────────────────────────────────────────────────
export async function handleModal(interaction) {
  const id = interaction.customId;

  // modal_fill_{recruitId}_{attr}
  if (id.startsWith('modal_fill_')) {
    const parts     = id.replace('modal_fill_', '').split('_');
    const recruitId = parseInt(parts[0]);
    const attr      = parts.slice(1).join('_');
    const raw       = interaction.fields.getTextInputValue('attr_value').trim();
    const val       = parseInt(raw);

    if (isNaN(val) || val < 50 || val > 99) {
      return interaction.reply({ content: '❌ Invalid value **' + raw + '** — must be a number between 50 and 99.', flags: 64 });
    }

    return advanceMissingFill(interaction, recruitId, attr, val);
  }
}


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
