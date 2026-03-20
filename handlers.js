import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { supabase } from './supabase.js';
import { performOCR, mapGridValues } from './utils/ocr.js';
import {
  getPositionRows, getArchetypeRows, getConfirmRow, getDeleteRow,
  createAnalysisEmbed, createBreakdownEmbed, createConfigEmbed,
  createRangeSummaryEmbed, createRecruitDetailEmbed, calculateFit, getAttributeOrder, getKeepDumpRow,
  SHORTLIST_STARTER_TYPES, shortlistRowColor, shortlistRowText,
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

// ── Shortlist Post Helper ────────────────────────────────────────────────────
// Posts the shortlist to a channel, deleting any previous shortlist message
// from the bot in that channel (identified by the 📋 **Your Shortlist** header).

async function postShortlist(channel, types, rows, activeSession, userId) {
  const { content } = buildShortlistContent(types, rows, activeSession);
  const components  = buildShortlistComponents(types, rows, activeSession ?? { step: 'main' });
  const payload     = { content, components };

  // Try to edit the existing message in place first
  if (userId) {
    const { data: cfg } = await supabase
      .from('shortlist_config')
      .select('message_id, channel_id')
      .eq('user_id', userId)
      .single();

    if (cfg?.message_id && cfg.channel_id === channel.id) {
      const existing = await channel.messages.fetch(cfg.message_id).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return existing;
      }
    }
  }

  // No existing message — send a new one and store its ID
  const newMsg = await channel.send(payload);
  if (userId) {
    await supabase.from('shortlist_config').upsert(
      { user_id: userId, message_id: newMsg.id, channel_id: channel.id },
      { onConflict: 'user_id' }
    );
  }
  return newMsg;
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

    let ocrValues = null, ocrName = null, ocrPosition = null, ocrArchetype = null;
    try {
      await interaction.editReply({ content: '🔍 Scanning attributes...' });
      const quick  = await performOCR(attachment.url);
      ocrValues    = quick.values;
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
      ocrValues,
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

  // /shortlist
  if (commandName === 'shortlist') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId  = interaction.user.id;
    const channel = interaction.channel;

    const types = await getOrSeedShortlistTypes(userId);
    let { rows } = await getShortlistData(userId, types);

    // First run — auto-import league names from todos table
    if (!rows.length) {
      const { data: todoLeagues } = await supabase
        .from('todos')
        .select('league')
        .eq('user_id', userId)
        .neq('league', null);

      const uniqueLeagues = [...new Set((todoLeagues ?? []).map(t => t.league).filter(Boolean))];
      for (const leagueName of uniqueLeagues) {
        await seedLeagueRows(userId, leagueName, types, []);
      }
      if (uniqueLeagues.length) {
        ({ rows } = await getShortlistData(userId, types));
      }
    }

    activeEdits.set(userId, { type: 'shortlist', step: 'main', channelId: channel.id });
    await postShortlist(channel, types, rows, { step: 'main' }, userId);
    // Acknowledge the slash command silently
    return interaction.editReply({ content: '✅ Shortlist posted.', flags: MessageFlags.Ephemeral });
  }

  // /shortlist-config
  if (commandName === 'shortlist-config') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const action  = interaction.options.getString('action');
    const name    = interaction.options.getString('name');
    const icon    = interaction.options.getString('icon');
    const newName = interaction.options.getString('new_name');

    const types = await getOrSeedShortlistTypes(userId);

    if (action === 'add') {
      if (!name || !icon) return interaction.editReply({ content: 'Please provide both a name and an icon emoji.' });
      const maxOrder = types.reduce((m, t) => Math.max(m, t.sort_order), 0);
      await supabase.from('shortlist_types').insert({ user_id: userId, name, icon, is_advance: false, sort_order: maxOrder + 1 });
      return interaction.editReply({ content: `✅ Added **${icon} ${name}** to your shortlist types.` });
    }

    if (action === 'remove') {
      if (!name) return interaction.editReply({ content: 'Please provide the name of the type to remove.' });
      const match = types.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!match) return interaction.editReply({ content: `No type named **${name}** found.` });
      if (match.is_advance) return interaction.editReply({ content: '⏰ **Advance** is a built-in type and cannot be removed.' });
      await supabase.from('shortlist').delete().eq('type_id', match.id);
      await supabase.from('shortlist_types').delete().eq('id', match.id);
      return interaction.editReply({ content: `🗑️ Removed **${match.icon} ${match.name}**.` });
    }

    if (action === 'rename') {
      if (!name || !newName) return interaction.editReply({ content: 'Please provide the current name and a new name.' });
      const match = types.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!match) return interaction.editReply({ content: `No type named **${name}** found.` });
      if (match.is_advance) return interaction.editReply({ content: '⏰ **Advance** is a built-in type and cannot be renamed.' });
      await supabase.from('shortlist_types').update({ name: newName }).eq('id', match.id);
      return interaction.editReply({ content: `✅ Renamed **${match.name}** → **${newName}**.` });
    }

    return interaction.editReply({ content: 'Unknown action.' });
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
function getMissingAttrRow(recruitId, attr, totalMissing = 1) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('fill_attr_' + recruitId + '_' + attr)
      .setLabel('Enter ' + attr)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('skip_attr_' + recruitId + '_' + attr)
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary),
  );
  // Only show "Fill all as 71" when there are multiple missing attributes
  if (totalMissing > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('fill_all_71_' + recruitId)
        .setLabel('Fill all as 71')
        .setStyle(ButtonStyle.Success)
    );
  }
  return row;
}


async function runAnalysis(interaction, session, position, archetype) {
  // Normalize display positions to canonical before DB lookup
  const POS_NORMALIZE = {
    MIKE: 'LB', SAM: 'LB', WILL: 'LB',
    RT: 'OT', LT: 'OT', LG: 'OG', RG: 'OG',
    FS: 'S', SS: 'S',
    LEDG: 'DE', REDG: 'DE',
  };
  const lookupPos = POS_NORMALIZE[position.toUpperCase()] || position.toUpperCase();

  const { data: arch, error: archErr } = await supabase
    .from('archetypes')
    .select('ranges')
    .eq('position', lookupPos)
    .eq('archetype', archetype)
    .single();

  console.log(`runAnalysis lookup: pos='${lookupPos}' arch='${archetype}' → found=${!!arch} keys=${arch?.ranges ? Object.keys(arch.ranges).length : 0} err=${archErr?.message ?? 'none'}`);
  const configuredAttrs = arch?.ranges ? Object.keys(arch.ranges) : [];

  if (configuredAttrs.length === 0) {
    return interaction.editReply({
      content: 'No ranges configured for **' + position + ' ' + archetype + '**.\nPlease run `/config` first to set up attribute ranges before analyzing.',
      components: [],
    });
  }

  let ocrValues, recruitName = null;
  try {
    if (session.ocrValues) {
      ocrValues   = session.ocrValues;
      recruitName = session.ocrName ?? null;
      await interaction.editReply({ content: '📊 Mapping attributes...' });
    } else {
      await interaction.editReply({ content: '🔍 Scanning attributes...' });
      const ocrResult = await performOCR(session.attachmentUrl);
      ocrValues   = ocrResult.values;
      recruitName = ocrResult.name;
      await interaction.editReply({ content: '📊 Mapping attributes...' });
    }
  } catch (err) {
    console.error('OCR failed:', err);
    activeEdits.delete(interaction.user.id);
    return interaction.editReply({ content: 'OCR failed. Try a clearer screenshot and run /analyze again.' });
  }

  // Map the 10 grid values to attribute keys using the on-screen display order
  // (getAttributeOrder), not configuredAttrs — the grid positions are fixed by
  // the game UI, not by what the league admin has configured ranges for.
  const gridOrder = getAttributeOrder(position, archetype);
  if (!gridOrder) {
    activeEdits.delete(interaction.user.id);
    return interaction.editReply({ content: 'Unknown position/archetype combination. Please pick manually.' });
  }
  const { attrs: allAttrs } = mapGridValues(ocrValues, gridOrder);

  // Filter down to only the attrs the league has configured ranges for
  const attributes     = Object.fromEntries(configuredAttrs.filter(a => a in allAttrs).map(a => [a, allAttrs[a]]));
  const missingFromOCR = configuredAttrs.filter(a => !(a in allAttrs));
  activeEdits.delete(interaction.user.id);

  if (Object.keys(attributes).length === 0) {
    return interaction.editReply({ content: 'No ratings found. Make sure the screenshot clearly shows the attribute grid.' });
  }

  const { data: recruit, error } = await supabase
    .from('recruits')
    .insert({ user_id: interaction.user.id, position: position.toUpperCase(), archetype, attributes, name: recruitName, status: 'pending' })
    .select()
    .single();

  if (error) return interaction.editReply({ content: 'Failed to save recruit. Try again.' });

  const foundCount = Object.keys(attributes).length;
  const missing    = missingFromOCR;

  if (missing.length > 0) {
    activeEdits.set(interaction.user.id, { type: 'filling_missing', id: recruit.id, missing, filled: 0, hasName: !!recruitName });
    const missingList = missing.map(a => '`' + a + '`').join(', ');
    return interaction.editReply({
      content: '📋 Found **' + foundCount + '/' + configuredAttrs.length + '** attributes' + (recruitName ? ' for **' + recruitName + '**' : '') + '.\n\nMissing: ' + missingList + '\n\nClick below to confirm or correct the value (pre-filled as **71** — the most common unread value):',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getMissingAttrRow(recruit.id, missing[0], missing.length)],
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

  // Route all shortlist buttons to dedicated handler
  if (id.startsWith('sl_')) return handleShortlistButton(interaction, id);

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
      .setValue('71')
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

  // fill_all_71_{recruitId} — fill every remaining missing attribute as 71
  if (id.startsWith('fill_all_71_')) {
    const recruitId = parseInt(id.replace('fill_all_71_', ''));
    const session   = activeEdits.get(interaction.user.id);
    if (!session || session.type !== 'filling_missing' || session.id !== recruitId) {
      return interaction.update({ content: 'Session expired. Please scan again.', components: [] });
    }
    await interaction.deferUpdate();

    // Fill all remaining missing attributes with 71
    const remaining = session.missing.slice(session.filled);
    for (const attr of remaining) {
      await supabase.from('recruits').update({ [attr.toLowerCase()]: 71 }).eq('id', recruitId);
    }

    // Mark all as filled and proceed to confirmation
    session.filled = session.missing.length;
    activeEdits.set(interaction.user.id, session);

    // Re-fetch recruit and run analysis
    const { data: recruit } = await supabase.from('recruits').select('*').eq('id', recruitId).single();
    if (!recruit) return interaction.editReply({ content: 'Recruit not found.', components: [] });

    activeEdits.set(interaction.user.id, { type: 'analyze_confirm', id: recruitId });
    return interaction.editReply({
      content: 'All missing attributes filled as **71** ✅' + (session.hasName ? '' : '\n\nConfirm to calculate fit score:'),
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruitId)],
    });
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
      components: [getKeepDumpRow(recruitId)],
    });
  }

  // keep_{id} — confirm kept, remove buttons
  if (id.startsWith('keep_')) {
    const recruitId = parseInt(id.replace('keep_', ''));
    await interaction.deferUpdate();
    const { data: recruit } = await supabase.from('recruits').select('name, position, archetype').eq('id', recruitId).single();
    const label = recruit?.name ?? (recruit ? recruit.position + ' ' + recruit.archetype : 'Recruit');
    await interaction.editReply({
      content: '✅ **' + label + '** kept.',
      components: [],
    });
  }

  // dump_{id} — hard delete from DB
  if (id.startsWith('dump_')) {
    const recruitId = parseInt(id.replace('dump_', ''));
    await interaction.deferUpdate();
    const { data: recruit } = await supabase.from('recruits').select('name, position, archetype').eq('id', recruitId).single();
    await supabase.from('recruits').delete().eq('id', recruitId);
    const label = recruit ? (recruit.name ? '**' + recruit.name + '**' : recruit.position + ' ' + recruit.archetype) : 'Recruit';
    await interaction.editReply({
      content: '🗑️ ' + label + ' removed.',
      embeds: [],
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

  // Modal submits use reply(); button interactions use update()
  const isModal = interaction.isModalSubmit?.() ?? false;
  const respond = (payload) => isModal
    ? interaction.reply({ ...payload, flags: 64 })
    : interaction.update(payload);

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
    return respond({
      content: (value !== null ? '✅ **' + attr + '** set to **' + value + '**.\n\n' : '⏭️ Skipped **' + attr + '**.\n\n') +
        '**' + remaining + '** attribute' + (remaining > 1 ? 's' : '') + ' remaining. Enter value for **' + nextAttr + '**:',
      embeds: [],
      components: [getMissingAttrRow(recruitId, nextAttr, session.missing.length - nextFilled)],
    });
  }

  // All done — go to name or confirm
  const { data: recruit } = await supabase.from('recruits').select('*').eq('id', recruitId).single();
  if (session.hasName) {
    activeEdits.set(interaction.user.id, { type: 'analyze_confirm', id: recruitId });
    return respond({
      content: '✅ All attributes filled! Confirm to calculate fit score:',
      embeds: [createAnalysisEmbed(recruit)],
      components: [getConfirmRow(recruitId)],
    });
  }
  activeEdits.set(interaction.user.id, { type: 'naming', id: recruitId });
  return respond({
    content: '✅ All attributes filled! Reply with the **recruit\'s name** (or type `skip` to leave unnamed):',
    embeds: [createAnalysisEmbed(recruit)],
    components: [],
  });
}

// ── Modal Handler ─────────────────────────────────────────────────────────────
export async function handleModal(interaction) {
  const id = interaction.customId;

  // sl_rename_modal_{encodedLeague} — save new league name
  if (id.startsWith('sl_rename_modal_')) {
    await interaction.deferUpdate();
    const encodedName = id.replace('sl_rename_modal_', '');
    const userId      = interaction.user.id;
    const channel     = interaction.channel;
    const newName     = interaction.fields.getTextInputValue('new_league_name_input').trim();
    if (!newName) return;

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const oldName = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;

    if (rows.find(r => r.league_name.toLowerCase() === newName.toLowerCase() && r.league_name !== oldName)) {
      return; // name already taken — silently ignore
    }

    await supabase.from('shortlist')
      .update({ league_name: newName })
      .eq('user_id', userId)
      .eq('league_name', oldName);

    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, freshRows, { step: 'main' }, userId);
    return;
  }

  // sl_add_league_modal — add a new league to the shortlist
  if (id === 'sl_add_league_modal') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId     = interaction.user.id;
    const channel    = interaction.channel;
    const leagueName = interaction.fields.getTextInputValue('league_name_input').trim();
    if (!leagueName) return interaction.editReply({ content: 'League name cannot be empty.' });

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);

    if (rows.find(r => r.league_name.toLowerCase() === leagueName.toLowerCase())) {
      return interaction.editReply({ content: `**${leagueName}** is already on your shortlist.` });
    }

    await seedLeagueRows(userId, leagueName, types, rows);
    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, freshRows, { step: 'main' }, userId);
    return interaction.editReply({ content: `✅ **${leagueName}** added.`, flags: MessageFlags.Ephemeral });
  }

  // sl_time_modal_{encodedLeague} — save advance time for a league
  if (id.startsWith('sl_time_modal_')) {
    await interaction.deferUpdate();
    const encodedName = id.replace('sl_time_modal_', '');
    const userId      = interaction.user.id;
    const channel     = interaction.channel;
    const rawVal      = interaction.fields.getTextInputValue('advance_time_input').trim();
    const newTime     = rawVal || null;

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);

    const leagueName = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;
    const advType    = types.find(t => t.is_advance);
    const advRow     = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);

    if (advRow) {
      await supabase.from('shortlist').update({ advance_time: newTime }).eq('id', advRow.id);
    }

    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(channel, types, freshRows, { step: 'edit_toggles', leagueName }, userId);
    return;
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST — DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getOrSeedShortlistTypes(userId) {
  const { data: existing } = await supabase
    .from('shortlist_types').select('*').eq('user_id', userId).order('sort_order');
  if (existing?.length) return existing;

  const rows = SHORTLIST_STARTER_TYPES.map((t, i) => ({
    user_id: userId, name: t.name, icon: t.icon,
    is_advance: t.is_advance ?? false, sort_order: i + 1,
  }));
  const { data: seeded } = await supabase.from('shortlist_types').insert(rows).select();
  return seeded ?? [];
}

async function getShortlistData(userId, types) {
  const { data: rows } = await supabase
    .from('shortlist').select('*').eq('user_id', userId).order('priority_order');

  // Fill gaps for any league missing rows for newer types
  const leagues = [...new Set((rows ?? []).map(r => r.league_name))];
  for (const leagueName of leagues) {
    await seedLeagueRows(userId, leagueName, types, rows ?? []);
  }

  // Re-fetch after seeding
  const { data: fresh } = await supabase
    .from('shortlist').select('*').eq('user_id', userId).order('priority_order');
  const normalized = fresh ?? [];

  // Normalize: ensure all rows for a league share the same priority_order (min of their values)
  // This fixes legacy rows seeded before the consistent-order fix
  const toFix = [];
  const leagueMap = new Map();
  for (const row of normalized) {
    const cur = leagueMap.get(row.league_name);
    if (cur === undefined || row.priority_order < cur) {
      leagueMap.set(row.league_name, row.priority_order);
    }
  }
  for (const row of normalized) {
    const canonical = leagueMap.get(row.league_name);
    if (row.priority_order !== canonical) toFix.push({ id: row.id, priority_order: canonical });
  }
  for (const fix of toFix) {
    await supabase.from('shortlist').update({ priority_order: fix.priority_order }).eq('id', fix.id);
  }
  if (toFix.length) {
    // Re-fetch one more time if we normalized anything
    const { data: renorm } = await supabase
      .from('shortlist').select('*').eq('user_id', userId).order('priority_order');
    return { rows: renorm ?? [] };
  }

  return { rows: normalized };
}

async function seedLeagueRows(userId, leagueName, types, existingRows = []) {
  const missing = types.filter(t =>
    !existingRows.find(r => r.league_name === leagueName && r.type_id === t.id)
  );
  if (!missing.length) return;

  // All rows for a league share the same priority_order — equal to the number
  // of distinct leagues already present + 1 (i.e. append at end of list)
  const existingLeagues = new Set(existingRows.map(r => r.league_name));
  existingLeagues.delete(leagueName); // don't count self if partially seeded
  const leagueOrder = existingLeagues.size + 1;

  await supabase.from('shortlist').insert(
    missing.map(t => ({
      user_id: userId,
      league_name: leagueName,
      type_id: t.id,
      state: 'off',
      priority_order: leagueOrder,
    }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST — DISPLAY BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildShortlistContent(types, rows, activeState) {
  const leagueNames = [...new Set(rows.map(r => r.league_name))];

  if (!leagueNames.length) {
    return { content: '📋 **Your Shortlist**\n\nNo leagues yet. Use **Add league** to get started.' };
  }

  const leagueData = leagueNames.map(name => {
    const items = rows.filter(r => r.league_name === name);
    const color = shortlistRowColor(items, types);
    const order = Math.min(...items.map(r => r.priority_order ?? 999));
    return { name, items, color, order };
  });
  leagueData.sort((a, b) => a.order - b.order);

  const editSteps = ['edit_toggles', 'item_state_pick'];
  const isEditing = activeState && editSteps.includes(activeState.step);

  const lines = leagueData.map((g, i) => {
    // advance_time is stored on the Advance type row for each league
    const advType = types.find(t => t.is_advance);
    const advRow  = advType && g.items.find(r => r.type_id === advType.id);
    const advTime = advRow?.advance_time ?? null;
    return shortlistRowText(i + 1, g.name, g.items, types, advTime);
  });

  const header = `📋 **Your Shortlist** — ${leagueNames.length} league${leagueNames.length !== 1 ? 's' : ''}`;
  const editingLine = isEditing ? `\n\n✏️ Updating **${activeState.leagueName}**` : '';

  return { content: header + '\n\n' + lines.join('\n') + editingLine };
}

function buildShortlistComponents(types, rows, state) {
  const leagues = [...new Set(rows.map(r => r.league_name))];

  const out = [];

  if (state.step === 'main') {
    const options = [
      new StringSelectMenuOptionBuilder().setLabel('Update league').setValue('edit').setEmoji('✏️'),
      new StringSelectMenuOptionBuilder().setLabel('Add league').setValue('add_league').setEmoji('➕'),
      new StringSelectMenuOptionBuilder().setLabel('Rename league').setValue('rename_league').setEmoji('🏷️'),
      new StringSelectMenuOptionBuilder().setLabel('Remove league').setValue('remove_league').setEmoji('🗑️'),
    ];
    if (leagues.length > 1) {
      options.splice(1, 0,
        new StringSelectMenuOptionBuilder().setLabel('Reorder leagues').setValue('reorder').setEmoji('↕️')
      );
    }
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_action')
        .setPlaceholder('Choose an action…')
        .addOptions(options)
    ));

  } else if (state.step === 'edit_pick') {
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_edit_league')
        .setPlaceholder('Pick a league to update…')
        .addOptions(leagues.map(name =>
          new StringSelectMenuOptionBuilder().setLabel(name).setValue(name)
        ))
    ));
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
    ));

  } else if (state.step === 'rename_pick') {
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_rename_pick')
        .setPlaceholder('Pick a league to rename…')
        .addOptions(leagues.map(name =>
          new StringSelectMenuOptionBuilder().setLabel(name).setValue(name)
        ))
    ));
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
    ));

  } else if (state.step === 'remove_pick') {
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_remove_pick')
        .setPlaceholder('Pick a league to remove…')
        .addOptions(leagues.map(name =>
          new StringSelectMenuOptionBuilder().setLabel(name).setValue(name)
        ))
    ));
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
    ));

  } else if (state.step === 'edit_toggles') {
    const leagueItems = rows.filter(r => r.league_name === state.leagueName);
    const advanceType = types.find(t => t.is_advance);
    const advanceItem = advanceType && leagueItems.find(r => r.type_id === advanceType.id);
    const advanceActive = advanceItem?.state === 'active';

    const STATE_STYLE  = { off: ButtonStyle.Secondary, active: ButtonStyle.Success, done: ButtonStyle.Success, paused: ButtonStyle.Primary };
    const STATE_PREFIX = { off: '⬜ ', active: '🟢 ', done: '✅ ', paused: '⏸️ ' };
    const enc = encodeLeague(state.leagueName);
    const itemButtons = types.map(t => {
      const item   = leagueItems.find(r => r.type_id === t.id);
      const iState = item?.state ?? 'off';
      return new ButtonBuilder()
        .setCustomId(`sl_select_${enc}_${t.id}`)
        .setLabel(`${STATE_PREFIX[iState]}${t.icon} ${t.name}`)
        .setStyle(STATE_STYLE[iState]);
    });
    for (let i = 0; i < itemButtons.length; i += 5) {
      out.push(new ActionRowBuilder().addComponents(itemButtons.slice(i, i + 5)));
    }
    // Advance time button — shows current value in label if set
    const advTimeRow  = advanceType && leagueItems.find(r => r.type_id === advanceType.id);
    const advTimeVal  = advTimeRow?.advance_time ?? null;
    const advTimeLbl  = advTimeVal ? `🕐 ${advTimeVal}` : '🕐 Set advance time';

    const actionButtons = [
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary),

    ];
    if (advanceActive) {
      actionButtons.unshift(
        new ButtonBuilder()
          .setCustomId(`sl_advance_complete_${enc}`)
          .setLabel('✅ Complete Advance')
          .setStyle(ButtonStyle.Success)
      );
    }
    // Advance time button always shown in edit view
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sl_set_time_${enc}`)
        .setLabel(advTimeLbl)
        .setStyle(advTimeVal ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ));
    out.push(new ActionRowBuilder().addComponents(actionButtons));

  } else if (state.step === 'item_state_pick') {
    const leagueItems = rows.filter(r => r.league_name === state.leagueName);
    const type        = types.find(t => t.id === state.typeId);
    const item        = leagueItems.find(r => r.type_id === state.typeId);
    const cur         = item?.state ?? 'off';
    const enc         = encodeLeague(state.leagueName);
    const mk = (label, value, style) => new ButtonBuilder()
      .setCustomId(`sl_setstate_${enc}_${state.typeId}_${value}`)
      .setLabel(label)
      .setStyle(cur === value ? ButtonStyle.Danger : style);
    out.push(new ActionRowBuilder().addComponents(
      mk('🟢 Active',  'active',  ButtonStyle.Success),
      mk('✅ Done',    'done',    ButtonStyle.Success),
      mk('⏸️ Paused', 'paused',  ButtonStyle.Primary),
      mk('⬜ Off',     'off',     ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_cancel_pick_${enc}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
    ));



  } else if (state.step === 'reorder_a') {
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_reorder_a')
        .setPlaceholder('Move which league?')
        .addOptions(leagues.map((name, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${name}`)
            .setValue(name)
        ))
    ));
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
    ));

  } else if (state.step === 'reorder_b') {
    // Position picker — show all positions except current one
    const currentPos = leagues.indexOf(state.leagueNameA) + 1;
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sl_reorder_b_${encodeLeague(state.leagueNameA)}`)
        .setPlaceholder(`Move to which position? (currently #${currentPos})`)
        .addOptions(
          leagues
            .map((name, i) => ({ name, pos: i + 1 }))
            .filter(({ name }) => name !== state.leagueNameA)
            .map(({ name, pos }) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`Position ${pos} — ${name}`)
                .setValue(String(pos))
            )
        )
    ));
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
    ));
  }

  return out;
}

// Encode league name for use in customId (spaces → hyphens, limit chars)
function encodeLeague(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST — SELECT MENU HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSelect(interaction) {
  const userId = interaction.user.id;
  const id     = interaction.customId;
  const value  = interaction.values[0];

  // Only handle shortlist selects
  if (!id.startsWith('sl_')) return;

  // Don't defer for add_league — showModal() requires a raw (non-deferred) interaction
  const isModalAction = (id === 'sl_action' && ['add_league'].includes(interaction.values[0])) || id === 'sl_rename_pick';
  if (!isModalAction) await interaction.deferUpdate();

  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const session = activeEdits.get(userId) ?? { type: 'shortlist', step: 'main' };
  const channel = interaction.channel;

  // sl_action — main menu choice
  if (id === 'sl_action') {
    if (value === 'edit') {
      activeEdits.set(userId, { type: 'shortlist', step: 'edit_pick' });
      const { content: c } = buildShortlistContent(types, rows);
      await postShortlist(channel, types, rows, { step: 'edit_pick' }, userId);
    }
    if (value === 'reorder') {
      activeEdits.set(userId, { type: 'shortlist', step: 'reorder_a' });
      const { content: c } = buildShortlistContent(types, rows);
      await postShortlist(channel, types, rows, { step: 'reorder_a' }, userId);
    }
    if (value === 'add_league') {
      const modal = new ModalBuilder()
        .setCustomId('sl_add_league_modal')
        .setTitle('Add League');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('league_name_input')
            .setLabel('League name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50)
        )
      );
      return interaction.showModal(modal);
    }

    if (value === 'rename_league') {
      // Pick which league to rename
      activeEdits.set(userId, { type: 'shortlist', step: 'rename_pick' });
      const { content: c } = buildShortlistContent(types, rows);
      await postShortlist(channel, types, rows, { step: 'rename_pick' }, userId);
      return;
    }

    if (value === 'remove_league') {
      // Pick which league to remove
      activeEdits.set(userId, { type: 'shortlist', step: 'remove_pick' });
      const { content: c } = buildShortlistContent(types, rows);
      await postShortlist(channel, types, rows, { step: 'remove_pick' }, userId);
      return;
    }
  }

  // sl_rename_pick — picked which league to rename, open modal
  if (id === 'sl_rename_pick') {
    const leagueName = value;
    const enc = encodeLeague(leagueName);
    const modal = new ModalBuilder()
      .setCustomId(`sl_rename_modal_${enc}`)
      .setTitle('Rename League');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('new_league_name_input')
          .setLabel('New league name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
          .setValue(leagueName)
      )
    );
    return interaction.showModal(modal);
  }

  // sl_remove_pick — picked which league to remove, execute immediately
  if (id === 'sl_remove_pick') {
    const leagueName = value;
    await supabase.from('shortlist').delete().eq('user_id', userId).eq('league_name', leagueName);
    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, freshRows, { step: 'main' }, userId);
    return;
  }

  // sl_edit_league — picked which league to edit
  if (id === 'sl_edit_league') {
    const leagueName = value;
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    const { content: c } = buildShortlistContent(types, rows);
    await postShortlist(channel, types, rows, { step: 'edit_toggles', leagueName }, userId);
  }

  // sl_reorder_a — picked which league to move, now pick destination position
  if (id === 'sl_reorder_a') {
    const leagueNameA = value;
    activeEdits.set(userId, { type: 'shortlist', step: 'reorder_b', leagueNameA });
    const { content: c } = buildShortlistContent(types, rows);
    const leagueNames = [...new Set(rows.map(r => r.league_name))];
    const currentPos  = leagueNames.indexOf(leagueNameA) + 1;
    await postShortlist(channel, types, rows, { step: 'reorder_b', leagueNameA }, userId);
  }

  // sl_reorder_b_{encodedLeagueA} — picked destination position, shift other leagues
  if (id.startsWith('sl_reorder_b_')) {
    const sess        = activeEdits.get(userId);
    const leagueNameA = sess?.leagueNameA ?? '';
    const destPos     = parseInt(value); // 1-based target position

    // Build current ordered league list
    const leagueNames = [...new Set(rows.map(r => r.league_name))];
    leagueNames.sort((a, b) => {
      const orderA = Math.min(...rows.filter(r => r.league_name === a).map(r => r.priority_order ?? 999));
      const orderB = Math.min(...rows.filter(r => r.league_name === b).map(r => r.priority_order ?? 999));
      return orderA - orderB;
    });

    const fromPos = leagueNames.indexOf(leagueNameA) + 1; // 1-based current position
    if (fromPos === 0 || fromPos === destPos) {
      // No-op — already there or not found
      activeEdits.set(userId, { type: 'shortlist', step: 'main' });
      const { content: c } = buildShortlistContent(types, rows);
      await postShortlist(channel, types, rows, { step: 'main' }, userId);
    }

    // Remove league from current position and insert at destination
    const reordered = [...leagueNames];
    reordered.splice(fromPos - 1, 1);           // remove from current spot
    reordered.splice(destPos - 1, 0, leagueNameA); // insert at destination

    // Write new priority_order values (1-based) for all leagues
    for (let i = 0; i < reordered.length; i++) {
      const name    = reordered[i];
      const newOrder = i + 1;
      const ids = rows.filter(r => r.league_name === name).map(r => r.id);
      if (ids.length) {
        await supabase.from('shortlist').update({ priority_order: newOrder }).in('id', ids);
      }
    }

    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    const { content: c } = buildShortlistContent(types, freshRows);
    await postShortlist(channel, types, freshRows, { step: 'main' }, userId);
  }
}

// SHORTLIST — BUTTON HANDLERS  (called from handleButton)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleShortlistButton(interaction, id) {
  const userId = interaction.user.id;

  // sl_set_time opens a modal — can't deferUpdate before showModal
  if (id.startsWith('sl_set_time_')) {
    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const encodedName = id.replace('sl_set_time_', '');
    const leagueName  = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;
    const advType     = types.find(t => t.is_advance);
    const advRow      = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);
    const currentVal  = advRow?.advance_time ?? '';

    const titleName = leagueName.length > 30 ? leagueName.slice(0, 27) + '...' : leagueName;
    const modal = new ModalBuilder()
      .setCustomId(`sl_time_modal_${encodedName}`)
      .setTitle(`Advance time — ${titleName}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('advance_time_input')
          .setLabel('Day + time (e.g. Fri 9pm) or blank')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(20)
          .setValue(currentVal)
      )
    );
    return interaction.showModal(modal);
  }

  await interaction.deferUpdate();

  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const channel = interaction.channel;

  // sl_back — return to main view
  if (id === 'sl_back') {
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    const { content } = buildShortlistContent(types, rows);
    return interaction.editReply({
      content,
      components: buildShortlistComponents(types, rows, { step: 'main' }),
    });
  }

  // sl_select_{encodedLeague}_{typeId} — user tapped an item, show state picker
  if (id.startsWith('sl_select_')) {
    const parts       = id.replace('sl_select_', '').split('_');
    const typeId      = parseInt(parts[parts.length - 1]);
    const encodedName = parts.slice(0, parts.length - 1).join('_');
    const leagueName  = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;
    const type = types.find(t => t.id === typeId);

    activeEdits.set(userId, { type: 'shortlist', step: 'item_state_pick', leagueName, typeId });
    const { content: c } = buildShortlistContent(types, rows);
    await postShortlist(channel, types, rows, { step: 'item_state_pick', leagueName, typeId }, userId);
  }
  // sl_setstate_{guildId}_{typeId}_{state} — apply the chosen state
  if (id.startsWith('sl_setstate_')) {
    const withoutPrefix  = id.replace('sl_setstate_', '');
    const lastUnderscore2 = withoutPrefix.lastIndexOf('_');
    const newState        = withoutPrefix.slice(lastUnderscore2 + 1);
    const remainder       = withoutPrefix.slice(0, lastUnderscore2);
    const lastUnderscore1 = remainder.lastIndexOf('_');
    const typeId          = parseInt(remainder.slice(lastUnderscore1 + 1));
    const encodedName     = remainder.slice(0, lastUnderscore1);
    const leagueName      = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;

    const row = rows.find(r => r.league_name === leagueName && r.type_id === typeId);
    if (row) {
      await supabase.from('shortlist').update({ state: newState }).eq('id', row.id);
    }

    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    const { content: c } = buildShortlistContent(types, freshRows);
    await postShortlist(channel, types, freshRows, { step: 'edit_toggles', leagueName }, userId);
  }

  // sl_cancel_pick_{guildId} — cancel state picker, back to edit_toggles
  if (id.startsWith('sl_cancel_pick_')) {
    const encodedName = id.replace('sl_cancel_pick_', '');
    const leagueName  = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    const { content: c } = buildShortlistContent(types, rows);
    await postShortlist(channel, types, rows, { step: 'edit_toggles', leagueName }, userId);
  }

  // sl_advance_complete — execute reset immediately, no confirmation
  if (id.startsWith('sl_advance_complete_')) {
    const encodedName = id.replace('sl_advance_complete_', '');
    const leagueName  = rows.find(r => encodeLeague(r.league_name) === encodedName)?.league_name ?? encodedName;

    await supabase.from('shortlist')
      .update({ state: 'active' })
      .eq('user_id', userId).eq('league_name', leagueName).eq('state', 'done');

    const advType = types.find(t => t.is_advance);
    if (advType) {
      await supabase.from('shortlist')
        .update({ advance_time: null })
        .eq('user_id', userId).eq('league_name', leagueName).eq('type_id', advType.id);
    }

    const { rows: freshRows } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, freshRows, { step: 'main' }, userId);
    return;
  }

  }
