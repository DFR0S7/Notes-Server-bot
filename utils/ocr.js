import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// GRID CONSTANTS  (calibrated against 3840×2160 screenshots, multiple teams)
// All values are fractions so they scale to any resolution automatically.
// ─────────────────────────────────────────────────────────────────────────────

// X bounds target ONLY the number glyphs, not the attribute label text.
// Verified pixel-level against 8186.jpg (Lawrence HB, Clemson).
const GRID_L_X1    = 0.526;   // left column  start
const GRID_L_X2    = 0.556;   // left column  end
const GRID_R_X1    = 0.630;   // right column start
const GRID_R_X2    = 0.660;   // right column end

// Number row y-centres — TALL glyph cluster centres, not label rows.
// Gap between rows is uniform ~140px at 2160p.
// Verified 10/10 correct against known values on 8186.jpg.
const GRID_ROW_Y   = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.018;  // crop window = centre ± 1.8% height

// ─────────────────────────────────────────────────────────────────────────────
// POSITION / ARCHETYPE CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_POSITIONS = [
  'QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S','ATH',
  'RT','LT','LG','RG','FS','SS','LEDG','REDG','SAM','WILL','MIKE',
];

const POS_MAP = {
  RT:'OT', LT:'OT', LG:'OG', RG:'OG',
  FS:'S',  SS:'S',
  LEDG:'DE', REDG:'DE',
  SAM:'LB', WILL:'LB', MIKE:'LB',
};

const FALLBACK_ARCHETYPES = [
  'Backfield Creator','Dual Threat','Pocket Passer','Pure Runner',
  'Elusive Bruiser','Backfield Threat','NS Receiver','NS Blocker',
  'Contact Seeker','East-West Playmaker',
  'Gadget','Physical Route Runner','Elusive Route Runner','Speedster',
  'Contested Specialist','Gritty Possession','Route Artist',
  'Vertical Threat','Pure Blocker','Possession',
  'Raw Strength','Well Rounded','Pass Protector','Agile',
  'Speed Rusher','Edge Setter','Power Rusher',
  'Pure Power','Gap Specialist',
  'Lurker','Signal Caller','Thumper',
  'Field','Zone','Bump','Boundary',
  'Coverage Specialist','Hybrid','Box',
];

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY AUTOCOMPLETE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/**
 * Find the best match for `raw` in `list`.
 * Priority: exact → starts-with → contains → Levenshtein ≤ maxDist
 */
function bestMatch(raw, list, maxDist = 3) {
  const norm = normalise(raw);
  if (!norm || norm.length < 2) return null;

  const exact = list.find(c => normalise(c) === norm);
  if (exact) return exact;

  const starts = list.filter(c => normalise(c).startsWith(norm) || norm.startsWith(normalise(c)));
  if (starts.length) return starts.sort((a, b) => b.length - a.length)[0];

  const contains = list.filter(c => {
    const cn = normalise(c);
    return norm.includes(cn) || cn.includes(norm);
  });
  if (contains.length) return contains.sort((a, b) => b.length - a.length)[0];

  if (norm.length <= 20) {
    let best = null, bestD = maxDist + 1;
    for (const c of list) {
      const d = levenshtein(norm, normalise(c));
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) return best;
  }

  return null;
}

function matchPosition(token) {
  const t = (token || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  if (VALID_POSITIONS.includes(t)) return POS_MAP[t] || t;
  // Fuzzy only for short tokens (position codes are ≤5 chars)
  if (t.length <= 5) {
    const m = bestMatch(t, VALID_POSITIONS, 1);
    if (m) return POS_MAP[m] || m;
  }
  return null;
}

function matchArchetype(raw, list) {
  return bestMatch(raw, list);
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID NUMBER EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function cropNumberCell(srcPath, x1, x2, yC, halfH, w, h, suffix) {
  const left   = Math.round(w * x1);
  const top    = Math.max(0, Math.round(h * (yC - halfH)));
  const width  = Math.round(w * (x2 - x1));
  const height = Math.min(h - top, Math.round(h * halfH * 2));

  // Save a normalised (autocontrast) version — threshold applied per-pass in ocrCell
  const tmpPath = join(tmpdir(), `recruit_cell_${suffix}_${Date.now()}.png`);
  await sharp(srcPath)
    .extract({ left, top, width, height })
    .greyscale()
    .toFile(tmpPath);  // raw greyscale — threshold applied per-pass in ocrCell

  return { tmpPath, width, height };
}

async function ocrCell(worker, cellData) {
  const { tmpPath, width } = cellData;

  for (const thresh of [100, 130, 160]) {
    const tmpThresh = tmpPath.replace('.png', `_t${thresh}.png`);
    await sharp(tmpPath)
      .threshold(thresh)
      .negate()
      .resize({ width: width * 8, kernel: 'nearest' })
      .toFile(tmpThresh);

    const result = await worker.recognize(tmpThresh);
    const raw = result.data.text.replace(/\s+/g, '').replace(/[^0-9]/g, '');

    for (const m of (raw.match(/\d{2,3}/g) || [])) {
      const n = parseInt(m);
      if (n >= 50 && n <= 99) {
        try { unlinkSync(tmpThresh); } catch {}
        return n;
      }
      if (m.length === 3) {
        const lastTwo   = parseInt(m[1] + m[2]);
        const firstLast = parseInt(m[0] + m[2]);
        if (lastTwo   >= 50 && lastTwo   <= 99) { try { unlinkSync(tmpThresh); } catch {} return lastTwo; }
        if (firstLast >= 50 && firstLast <= 99) { try { unlinkSync(tmpThresh); } catch {} return firstLast; }
      }
    }
    try { unlinkSync(tmpThresh); } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NAME EXTRACTION  (original working logic — untouched)
// Crop: x 45–72%, y 12–25%
// ─────────────────────────────────────────────────────────────────────────────

async function extractName(srcPath, w, h, worker) {
  const nameLeft   = Math.floor(w * 0.45);
  const nameTop    = Math.floor(h * 0.12);
  const nameWidth  = Math.floor(w * 0.27);
  const nameHeight = Math.floor(h * 0.13);

  if (nameWidth < 10 || nameHeight < 10) return null;

  const tmpName = join(tmpdir(), `recruit_name_${Date.now()}.png`);
  try {
    await sharp(srcPath)
      .extract({ left: nameLeft, top: nameTop, width: nameWidth, height: nameHeight })
      .greyscale().normalise()
      .resize({ width: nameWidth * 2, kernel: 'cubic' })
      .toFile(tmpName);

    await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
    const nameResult = await worker.recognize(tmpName);

    const SKIP_WORDS = /^(POSITION|ARCHETYPE|CLASS|HOMETOWN|ATH|QB|HB|WR|TE|OT|OG|DE|DT|LB|CB|SS|FS)$/;
    const recruitName = nameResult.data.text
      .split('\n')
      .map(l => l.replace(/[^A-Za-z\s]/g, '').trim())
      .map(l => l.split(/\s+/)[0])
      .filter(w => w && /^[A-Z][A-Za-z]{2,}$/.test(w) && !SKIP_WORDS.test(w))
      .slice(0, 2)
      .join(' ') || null;

    console.log('OCR name:', recruitName);
    return recruitName;
  } finally {
    try { unlinkSync(tmpName); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION + ARCHETYPE EXTRACTION
//
// Uses two dedicated labeled boxes that the game UI always renders:
//   POSITION box  → x: 68–80%, y: 13–23%  reads "HB", "WR", "RT" etc.
//   ARCHETYPE box → x: 68–82%, y: 23–32%  reads full display name
//
// Display names → DB names for archetypes the game shows differently:
// ─────────────────────────────────────────────────────────────────────────────

const ARCHETYPE_DISPLAY_MAP = {
  'north south receiver': 'NS Receiver',
  'north/south receiver': 'NS Receiver',
  'ns receiver':          'NS Receiver',
  'north south blocker':  'NS Blocker',
  'north/south blocker':  'NS Blocker',
  'ns blocker':           'NS Blocker',
  'east west playmaker':  'East-West Playmaker',
  'east/west playmaker':  'East-West Playmaker',
  'backfield threat':     'Backfield Threat',
  'backfield creator':    'Backfield Creator',
  'elusive bruiser':      'Elusive Bruiser',
  'contact seeker':       'Contact Seeker',
  'physical route runner':'Physical Route Runner',
  'elusive route runner': 'Elusive Route Runner',
  'contested specialist': 'Contested Specialist',
  'gritty possession':    'Gritty Possession',
  'route artist':         'Route Artist',
  'vertical threat':      'Vertical Threat',
  'pure blocker':         'Pure Blocker',
  'pure power':           'Pure Power',
  'gap specialist':       'Gap Specialist',
  'speed rusher':         'Speed Rusher',
  'power rusher':         'Power Rusher',
  'edge setter':          'Edge Setter',
  'raw strength':         'Raw Strength',
  'well rounded':         'Well Rounded',
  'pass protector':       'Pass Protector',
  'signal caller':        'Signal Caller',
  'coverage specialist':  'Coverage Specialist',
  'dual threat':          'Dual Threat',
  'pocket passer':        'Pocket Passer',
  'pure runner':          'Pure Runner',
  'backfield creator':    'Backfield Creator',
};

async function extractPositionArchetype(srcPath, w, h, archetypeList, worker) {
  // ── POSITION: dedicated labeled box x=68-80%, y=13-23% ──────────────────
  const posLeft   = Math.round(w * 0.68);
  const posTop    = Math.round(h * 0.13);
  const posWidth  = Math.round(w * 0.12);
  const posHeight = Math.round(h * 0.10);
  const tmpPos  = join(tmpdir(), `recruit_pos_${Date.now()}.png`);

  // ── ARCHETYPE: dedicated labeled box x=68-82%, y=23-32% ─────────────────
  const archLeft   = Math.round(w * 0.68);
  const archTop    = Math.round(h * 0.23);
  const archWidth  = Math.round(w * 0.14);
  const archHeight = Math.round(h * 0.09);
  const tmpArch = join(tmpdir(), `recruit_arch_${Date.now()}.png`);

  try {
    await Promise.all([
      sharp(srcPath)
        .extract({ left: posLeft, top: posTop, width: posWidth, height: posHeight })
        .greyscale().normalise()
        .resize({ width: posWidth * 3, kernel: 'cubic' })
        .toFile(tmpPos),
      sharp(srcPath)
        .extract({ left: archLeft, top: archTop, width: archWidth, height: archHeight })
        .greyscale().normalise()
        .resize({ width: archWidth * 3, kernel: 'cubic' })
        .toFile(tmpArch),
    ]);

    await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });

    const [posResult, archResult] = await Promise.all([
      worker.recognize(tmpPos),
      worker.recognize(tmpArch),
    ]);

    // ── Parse position ───────────────────────────────────────────────────────
    // Skip known label words; take first token that matches a position code
    const SKIP_POS = /^(POSITION|CLASS|HIGH|SCHOOL|ARCHETYPE|HOMETOWN|NAT|STA|POS)$/;
    let position = null;
    for (const line of posResult.data.text.split('\n')) {
      for (const tok of line.split(/\s+/)) {
        const clean = tok.replace(/[^A-Za-z]/g, '').toUpperCase();
        if (!clean || SKIP_POS.test(clean)) continue;
        const p = matchPosition(clean);
        if (p) { position = p; break; }
      }
      if (position) break;
    }

    // ── Parse archetype ──────────────────────────────────────────────────────
    // Strip label words, try progressively shorter word prefixes so trailing
    // city / noise tokens don't prevent matching "North/South Receiver Rio Ra ne"
    const SKIP_ARCH = /^(ARCHETYPE|HOMETOWN|HIGH|SCHOOL|CLASS|POSITION|NAT|STA|POS|TC|TOP)$/;
    let archetype = null;
    const archLines = archResult.data.text.split('\n')
      .map(l => l.replace(/\|/g, ' ').trim())
      .filter(l => l.length > 1);

    outer:
    for (const line of archLines) {
      const words = line.split(/\s+/).filter(w => !SKIP_ARCH.test(w.toUpperCase()));
      if (!words.length) continue;

      // Try decreasing prefix lengths so trailing city noise is ignored
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ').trim();
        if (!candidate) continue;

        // Display name map first (handles North/South Receiver, NS Blocker etc.)
        const mapped = ARCHETYPE_DISPLAY_MAP[candidate.toLowerCase()];
        if (mapped) { archetype = mapped; break outer; }

        // Fuzzy match against DB + fallback list
        const match = matchArchetype(candidate, archetypeList);
        if (match) { archetype = match; break outer; }
      }
    }

    // ── Derive position from archetype when OCR position is wrong/missing ────
    // Build an inverted map from the known ARCHETYPES constant.
    // Archetypes shared across positions (OL trio, WR/TE Physical Route Runner)
    // are resolved using the OCR position as a tiebreaker.
    const ARCHETYPE_TO_POS = {
      // QB
      'Backfield Creator': ['QB'], 'Dual Threat': ['QB'], 'Pocket Passer': ['QB'], 'Pure Runner': ['QB'],
      // HB — all unique
      'Elusive Bruiser': ['HB'], 'Backfield Threat': ['HB'], 'NS Receiver': ['HB'],
      'NS Blocker': ['HB'], 'Contact Seeker': ['HB'], 'East-West Playmaker': ['HB'],
      // WR — Physical Route Runner shared with TE
      'Gadget': ['WR'], 'Physical Route Runner': ['WR','TE'], 'Elusive Route Runner': ['WR'],
      'Speedster': ['WR'], 'Contested Specialist': ['WR'], 'Gritty Possession': ['WR'], 'Route Artist': ['WR'],
      // TE
      'Vertical Threat': ['TE'], 'Pure Blocker': ['TE'], 'Possession': ['TE'],
      // OL — shared across OT/OG/C
      'Raw Strength': ['OT','OG','C'], 'Well Rounded': ['OT','OG','C'],
      'Pass Protector': ['OT','OG','C'], 'Agile': ['OT','OG','C'],
      // DE
      'Speed Rusher': ['DE','DT'], 'Edge Setter': ['DE'], 'Power Rusher': ['DE','DT'],
      // DT
      'Pure Power': ['DT'], 'Gap Specialist': ['DT'],
      // LB
      'Lurker': ['LB'], 'Signal Caller': ['LB'], 'Thumper': ['LB'],
      // CB
      'Field': ['CB'], 'Zone': ['CB'], 'Bump': ['CB'], 'Boundary': ['CB'],
      // S
      'Coverage Specialist': ['S'], 'Hybrid': ['S'], 'Box': ['S'],
    };

    if (archetype) {
      const candidates = ARCHETYPE_TO_POS[archetype];
      if (candidates) {
        if (candidates.length === 1) {
          // Unambiguous — override OCR position entirely
          if (position !== candidates[0]) {
            console.log(`Position corrected by archetype: ${position} → ${candidates[0]} (archetype: ${archetype})`);
          }
          position = candidates[0];
        } else if (!candidates.includes(position)) {
          // Ambiguous archetype AND OCR position isn't one of the valid options
          // Fall back to first candidate (most common)
          console.log(`Position ambiguous for archetype "${archetype}", candidates: ${candidates}, OCR was: ${position} — using ${candidates[0]}`);
          position = candidates[0];
        }
        // else: ambiguous but OCR position is valid — keep it
      }
    }

    console.log('OCR position:', position, '| archetype:', archetype);
    return { position, archetype };
  } finally {
    try { unlinkSync(tmpPos);  } catch {}
    try { unlinkSync(tmpArch); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download image, run grid OCR for the 10 attribute numbers, and extract
 * name / position / archetype from the card header.
 *
 * Returns:
 *   values    – [L1,R1,L2,R2,L3,R3,L4,R4,L5,R5]  number|null per cell
 *   name      – recruit name string or null
 *   position  – canonical position string or null
 *   archetype – archetype string or null
 */
export async function performOCR(imageUrl) {
  const tmpRaw    = join(tmpdir(), `recruit_raw_${Date.now()}.png`);
  const cellPaths = new Array(10).fill(null);

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const { width: w, height: h } = await sharp(tmpRaw).metadata();
  console.log(`Image: ${w}×${h}`);

  // Build 10 cell crops concurrently: [L1,R1,L2,R2,L3,R3,L4,R4,L5,R5]
  const cropJobs = [];
  for (let row = 0; row < 5; row++) {
    const yC = GRID_ROW_Y[row];
    cropJobs.push({ idx: row*2,     x1: GRID_L_X1, x2: GRID_L_X2, yC, suffix: `r${row+1}L` });
    cropJobs.push({ idx: row*2 + 1, x1: GRID_R_X1, x2: GRID_R_X2, yC, suffix: `r${row+1}R` });
  }

  await Promise.allSettled(
    cropJobs.map(async ({ idx, x1, x2, yC, suffix }) => {
      try {
        cellPaths[idx] = await cropNumberCell(tmpRaw, x1, x2, yC, GRID_ROW_HALF, w, h, suffix);
      } catch (e) {
        console.error(`Cell crop ${suffix} failed:`, e.message);
      }
    })
  );

  // Fetch archetype list from DB; merge with fallback
  const { data: dbArchetypes } = await supabase.from('archetypes').select('archetype');
  const dbList = dbArchetypes?.map(a => a.archetype) || [];
  const archetypeList = [...new Set([...dbList, ...FALLBACK_ARCHETYPES])];

  // Single worker for all OCR tasks
  const worker = await createWorker('eng', 1, {
    // Suppress Tesseract internal warnings (too-small regions, unrecognizable lines)
    logger: () => {},
    errorHandler: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  let values, name = null, position = null, archetype = null;

  try {
    // 1. OCR the 10 number cells — sequential to avoid worker param conflicts
    values = [];
    for (const c of cellPaths) {
      try {
        values.push(c ? await ocrCell(worker, c) : null);
      } catch {
        values.push(null);
      }
    }
    console.log('Grid values [L1,R1,L2,R2,L3,R3,L4,R4,L5,R5]:', values);

    // 2. Name — original crop + parse logic, completely separate
    name = await extractName(tmpRaw, w, h, worker);

    // 3. Position + archetype — dedicated header region, fuzzy autocomplete
    ({ position, archetype } = await extractPositionArchetype(
      tmpRaw, w, h, archetypeList, worker
    ));

  } finally {
    await worker.terminate();
    try { unlinkSync(tmpRaw); } catch {}
    for (const c of cellPaths) if (c) try { unlinkSync(c.tmpPath); } catch {}
  }

  return { values, name, position, archetype };
}

/**
 * Map the 10 grid values to a keyed attribute object using the given order.
 *
 * attrOrder index → values index:
 *   0=L1, 1=R1, 2=L2, 3=R2, 4=L3, 5=R3, 6=L4, 7=R4, 8=L5, 9=R5
 *
 * Returns { attrs, missing } where missing lists keys with unreadable values
 * so the manual fill prompt can handle them.
 */
export function mapGridValues(values, attrOrder) {
  if (!attrOrder || attrOrder.length !== 10 || !values) {
    return { attrs: {}, missing: attrOrder || [] };
  }

  const attrs   = {};
  const missing = [];

  for (let i = 0; i < 10; i++) {
    const key = attrOrder[i];
    const val = values[i];
    if (typeof val === 'number' && val >= 50 && val <= 99) {
      attrs[key] = val;
    } else {
      missing.push(key);
    }
  }

  console.log('mapGridValues → attrs:', attrs, '| missing:', missing);
  return { attrs, missing };
}
