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

const GRID_L_X1    = 0.465;   // left column  start
const GRID_L_X2    = 0.585;   // left column  end
const GRID_R_X1    = 0.626;   // right column start
const GRID_R_X2    = 0.754;   // right column end

// Number row y-centres — same for both left and right columns
const GRID_ROW_Y   = [0.439, 0.491, 0.552, 0.617, 0.683];
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
  const tmpPath = join(tmpdir(), `recruit_cell_${suffix}_${Date.now()}.png`);

  await sharp(srcPath)
    .extract({ left, top, width, height })
    .greyscale()
    .threshold(100)   // bright number text survives; dark bg becomes black
    .negate()         // flip → black text on white background for Tesseract
    .resize({ width: width * 5, kernel: 'nearest' })
    .toFile(tmpPath);

  return tmpPath;
}

async function ocrCell(worker, imgPath) {
  const result = await worker.recognize(imgPath);
  const raw = result.data.text.replace(/\s+/g, '').replace(/[^0-9]/g, '');

  for (const m of (raw.match(/\d{2,3}/g) || [])) {
    const n = parseInt(m);
    if (n >= 50 && n <= 99) return n;
    // 3-digit rescue: try last-two then first+last
    if (m.length === 3) {
      const lastTwo   = parseInt(m[1] + m[2]);
      const firstLast = parseInt(m[0] + m[2]);
      if (lastTwo   >= 50 && lastTwo   <= 99) return lastTwo;
      if (firstLast >= 50 && firstLast <= 99) return firstLast;
    }
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
// POSITION + ARCHETYPE EXTRACTION  (separate header region — new approach)
// Crop: x 38–90%, y 18–30%
// Covers both the name row ("LASTNAME [POS] | High School") and the stats
// line ("nat:[n] | sta:[n] | Pos:[rank] [Archetype] | City").
// ─────────────────────────────────────────────────────────────────────────────

async function extractPositionArchetype(srcPath, w, h, archetypeList, worker) {
  const left   = Math.round(w * 0.38);
  const top    = Math.round(h * 0.18);
  const width  = Math.round(w * 0.52);
  const height = Math.round(h * 0.12);
  const tmpPath = join(tmpdir(), `recruit_meta_${Date.now()}.png`);

  try {
    await sharp(srcPath)
      .extract({ left, top, width, height })
      .greyscale().normalise()
      .resize({ width: width * 3, kernel: 'cubic' })
      .toFile(tmpPath);

    await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
    const result = await worker.recognize(tmpPath);
    const lines  = result.data.text
      .split('\n')
      .map(l => l.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 1);

    console.log('Meta OCR lines:', lines);

    let position  = null;
    let archetype = null;

    for (const line of lines) {
      // ── Position: first token on any line that matches a known position ──
      if (!position) {
        for (const tok of line.split(/\s+/)) {
          const p = matchPosition(tok);
          if (p) { position = p; break; }
        }
      }

      // ── Archetype: "Pos: [rank] [Archetype words]" pattern ───────────────
      if (!archetype) {
        const m = line.match(/[Pp]os\s*[:.]?\s*\d+\s+([\w\s]+)/);
        if (m) {
          const candidate = m[1].split(/[|,]/)[0].trim();
          archetype = matchArchetype(candidate, archetypeList);
        }
      }

      // ── Archetype fallback: match anywhere on the line ───────────────────
      if (!archetype) {
        archetype = matchArchetype(line, archetypeList);
      }

      if (position && archetype) break;
    }

    console.log('OCR position:', position, '| archetype:', archetype);
    return { position, archetype };
  } finally {
    try { unlinkSync(tmpPath); } catch {}
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
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  let values, name = null, position = null, archetype = null;

  try {
    // 1. OCR the 10 number cells
    const ocrResults = await Promise.allSettled(
      cellPaths.map(p => p ? ocrCell(worker, p) : Promise.resolve(null))
    );
    values = ocrResults.map(r => r.status === 'fulfilled' ? r.value : null);
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
    for (const p of cellPaths) if (p) try { unlinkSync(p); } catch {}
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
