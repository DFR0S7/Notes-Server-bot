import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// GRID CONSTANTS  (calibrated against 3840×2160 screenshots)
// ─────────────────────────────────────────────────────────────────────────────

const GRID_L_X1   = 0.526;   // left column  start  (x%)
const GRID_L_X2   = 0.556;   // left column  end
const GRID_R_X1   = 0.630;   // right column start
const GRID_R_X2   = 0.660;   // right column end

const GRID_ROW_Y    = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.020;   // ±2.0% → ~43 px at 2160 p

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN POSITIONS
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
// FUZZY / AUTOCOMPLETE HELPERS
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
    .threshold(100)
    .negate()
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
// HEADER EXTRACTION (position, archetype, name)
// ─────────────────────────────────────────────────────────────────────────────

async function extractHeader(srcPath, w, h, archetypeList, worker) {
  const left   = Math.round(w * 0.38);
  const top    = Math.round(h * 0.18);
  const width  = Math.round(w * 0.52);
  const height = Math.round(h * 0.12);
  const tmpPath = join(tmpdir(), `recruit_header_${Date.now()}.png`);

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

    console.log('Header OCR lines:', lines);

    let position  = null;
    let archetype = null;
    let name      = null;

    const SKIP = /^(POSITION|ARCHETYPE|CLASS|HOMETOWN|ATH|QB|HB|WR|TE|OT|OG|C|DE|DT|LB|CB|S|SS|FS|RT|LT|HIGH|SCHOOL|NAT|STA|POS|TOP)$/;

    for (const line of lines) {
      const tokens = line.split(/\s+/);

      if (!position) {
        for (const tok of tokens) {
          const p = matchPosition(tok);
          if (p) { position = p; break; }
        }
      }

      if (!archetype) {
        const m = line.match(/[Pp]os\s*[:.]?\s*\d+\s+([\w\s]+)/);
        if (m) {
          const candidate = m[1].split(/[|,]/)[0].trim();
          archetype = matchArchetype(candidate, archetypeList);
        }
      }
      if (!archetype) {
        archetype = matchArchetype(line, archetypeList);
      }

      if (!name) {
        const words = tokens.filter(w =>
          w.length >= 2 && /^[A-Z][A-Za-z]+$/.test(w) && !SKIP.test(w.toUpperCase())
        );
        if (words.length >= 1) name = words.slice(0, 2).join(' ');
      }
    }

    return { position, archetype, name };
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export async function performOCR(imageUrl) {
  const tmpRaw = join(tmpdir(), `recruit_raw_${Date.now()}.png`);
  const cellPaths = new Array(10).fill(null);

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const { width: w, height: h } = await sharp(tmpRaw).metadata();
  console.log(`Image: ${w}×${h}`);

  const cropJobs = [];
  for (let row = 0; row < 5; row++) {
    const yC = GRID_ROW_Y[row];
    cropJobs.push({ idx: row*2,   x1: GRID_L_X1, x2: GRID_L_X2, yC, suffix: `r${row+1}L` });
    cropJobs.push({ idx: row*2+1, x1: GRID_R_X1, x2: GRID_R_X2, yC, suffix: `r${row+1}R` });
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

  const { data: dbArchetypes } = await supabase.from('archetypes').select('archetype');
  const dbList = dbArchetypes?.map(a => a.archetype) || [];
  const archetypeList = [...new Set([...dbList, ...FALLBACK_ARCHETYPES])];

  const worker = await createWorker('eng', 1, {
    logger: () => {},
    errorHandler: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  let values, name = null, position = null, archetype = null;

  try {
    // OCR cells sequentially to avoid shared worker state conflicts
    values = [];
    for (const p of cellPaths) {
      try {
        values.push(p ? await ocrCell(worker, p) : null);
      } catch {
        values.push(null);
      }
    }
    console.log('Grid values [L1,R1,L2,R2,L3,R3,L4,R4,L5,R5]:', values);

    ({ position, archetype, name } = await extractHeader(
      tmpRaw, w, h, archetypeList, worker
    ));
    console.log('Header → position:', position, '| archetype:', archetype, '| name:', name);

  } finally {
    await worker.terminate();
    try { unlinkSync(tmpRaw); } catch {}
    for (const p of cellPaths) if (p) try { unlinkSync(p); } catch {}
  }

  return { values, name, position, archetype };
}

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
