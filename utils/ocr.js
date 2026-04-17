import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

const DEBUG = true;
const log = (...a) => DEBUG && console.log('[OCR]', ...a);
const err = (...a) => console.error('[OCR]', ...a);

/* ─────────────────────────────────────────────
   GRID CONSTANTS (UNCHANGED)
───────────────────────────────────────────── */
const GRID_L_X1 = 0.526;
const GRID_L_X2 = 0.556;
const GRID_R_X1 = 0.630;
const GRID_R_X2 = 0.660;
const GRID_ROW_Y = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.018;

/* ─────────────────────────────────────────────
   WORKER (singleton)
───────────────────────────────────────────── */
let worker;
async function getWorker() {
  if (!worker) {
    log('Creating Tesseract worker');
    worker = await createWorker('eng', 1, {
      logger: m => DEBUG && m.status && log(m.status),
    });
  }
  return worker;
}

/* ─────────────────────────────────────────────
   IMAGE CROPPING
───────────────────────────────────────────── */
async function cropNumberCell(src, x1, x2, yC, halfH, w, h, label) {
  const left = Math.round(w * x1);
  const top = Math.max(0, Math.round(h * (yC - halfH)));
  const width = Math.round(w * (x2 - x1));
  const height = Math.round(h * halfH * 2);

  log('Crop', label, { left, top, width, height });

  const tmp = join(tmpdir(), `cell_${label}_${Date.now()}.png`);

  await sharp(src)
    .extract({ left, top, width, height })
    .greyscale()
    .threshold(100)
    .negate()
    .resize({ width: width * 8, kernel: 'nearest' }) // keep accuracy
    .toFile(tmp);

  return tmp;
}

/* ─────────────────────────────────────────────
   OCR NUMBER
───────────────────────────────────────────── */
async function ocrCell(worker, path) {
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  const res = await worker.recognize(path);
  const raw = res.data.text.replace(/\D/g, '');
  log('OCR cell raw:', raw);

  for (const m of raw.match(/\d{2,3}/g) || []) {
    const n = parseInt(m, 10);
    if (n >= 50 && n <= 99) return n;
  }
  return null;
}

/* ─────────────────────────────────────────────
   MAIN OCR
───────────────────────────────────────────── */
export async function performOCR(imageUrl) {
   console.error('[OCR] performOCR() CALLED');
   console.error('[OCR] Image URL:', imageUrl); 
   log('Starting OCR:', imageUrl);

  const tmpRaw = join(tmpdir(), `raw_${Date.now()}.png`);
  const resp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  writeFileSync(tmpRaw, resp.data);

  const meta = await sharp(tmpRaw).metadata();
  log('Image meta:', meta);

  const { width: w, height: h } = meta;

  const worker = await getWorker();
  const cellPaths = [];
  const values = [];

  try {
    for (let r = 0; r < 5; r++) {
      const y = GRID_ROW_Y[r];
      cellPaths.push(await cropNumberCell(tmpRaw, GRID_L_X1, GRID_L_X2, y, GRID_ROW_HALF, w, h, `R${r}L`));
      cellPaths.push(await cropNumberCell(tmpRaw, GRID_R_X1, GRID_R_X2, y, GRID_ROW_HALF, w, h, `R${r}R`));
    }

    for (const p of cellPaths) {
      values.push(await ocrCell(worker, p));
    }

    log('Grid values:', values);

    return { values };
  } finally {
    for (const p of cellPaths) try { unlinkSync(p); } catch {}
    try { unlinkSync(tmpRaw); } catch {}
  }
   // 2. Name extraction
name = await extractName(tmpRaw, w, h, worker);

// 3. Position + archetype
({ position, archetype } = await extractPositionArchetype(
  console.error('[OCR] extractPositionArchetype CALLED');
console.error('[OCR] Meta region box:', { left, top, width, height });
   tmpRaw,
  w,
  h,
  archetypeList,
  worker
   console.error('[OCR] Meta OCR raw text:', result.data.text);

));
   return { values, name, position, archetype };
}
export function mapGridValues(values, attrOrder) {
  if (!Array.isArray(values) || !Array.isArray(attrOrder) || attrOrder.length !== 10) {
    console.warn('[OCR] Invalid input to mapGridValues');
    return { attrs: {}, missing: attrOrder ?? [] };
  }

  const attrs = {};
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

  console.log('[OCR] mapGridValues → attrs:', attrs, 'missing:', missing);
  return { attrs, missing };
}
