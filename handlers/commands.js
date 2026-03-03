import { supabase } from '../supabase.js';
import { getPositionRows, getDeleteRow } from '../utils/buttons.js';

export async function handleCommand(interaction) {
  const { commandName } = interaction;

  // /analyze — show position picker, screenshot attached here
  if (commandName === 'analyze') {
    const attachment = interaction.options.getAttachment('screenshot');

    if (!attachment?.contentType?.startsWith('image/')) {
      return interaction.reply({ content: 'Please attach a valid image file.', ephemeral: true });
    }

    // Store attachment URL in activeEdits so we can use it after position/archetype selected
    const { activeEdits } = await import('../index.js');
    activeEdits.set(interaction.user.id, {
      type: 'analyze_pending',
      attachmentUrl: attachment.url,
    });

    await interaction.reply({
      content: 'Step 1: Select a position',
      components: getPositionRows('analyze'),
      ephemeral: true,
    });
  }

  // /config — show position picker
  if (commandName === 'config') {
    await interaction.reply({
      content: 'Step 1: Select a position',
      components: getPositionRows('config'),
      ephemeral: true,
    });
  }

  // /list-recruits
  if (commandName === 'list-recruits') {
    const { data, error } = await supabase
      .from('recruits')
      .select('id, position, archetype, fit_score, created_at')
      .eq('user_id', interaction.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data?.length) {
      return interaction.reply({ content: 'No recruits saved yet. Use /analyze to add one!', ephemeral: true });
    }

    const lines = data.map(r => {
      const score = r.fit_score !== null ? r.fit_score + '%' : 'Pending';
      const date  = new Date(r.created_at).toLocaleDateString();
      return '#' + r.id + ' | ' + r.position + ' ' + r.archetype + ' | Fit: ' + score + ' | ' + date;
    }).join('\n');

    await interaction.reply({ content: 'Your Recruits (last 20)\n' + lines, ephemeral: true });
  }

  // /clear-recruit
  if (commandName === 'clear-recruit') {
    const id = interaction.options.getInteger('id');

    const { data } = await supabase
      .from('recruits')
      .select('id, position, archetype')
      .eq('id', id)
      .eq('user_id', interaction.user.id)
      .single();

    if (!data) {
      return interaction.reply({ content: 'Recruit #' + id + ' not found or does not belong to you.', ephemeral: true });
    }

    await interaction.reply({
      content: 'Delete #' + id + ' ' + data.position + ' ' + data.archetype + '? This cannot be undone.',
      components: [getDeleteRow(id)],
      ephemeral: true,
    });
  }
}
