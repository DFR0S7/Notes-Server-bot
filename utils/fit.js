import { supabase } from '../supabase.js';

export async function calculateFit(position, archetype, attributes) {
  const { data: arch, error } = await supabase
    .from('archetypes')
    .select('ranges')
    .eq('position', position.toUpperCase())
    .eq('archetype', archetype)
    .single();

  if (error || !arch) {
    return {
      score: 0,
      breakdown: [],
      warning: 'No ranges configured for this archetype. Use /config first.',
    };
  }

  const ranges = arch.ranges || {};
  const breakdown = [];
  let matched = 0;
  let total = 0;

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
