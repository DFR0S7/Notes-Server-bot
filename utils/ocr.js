import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

// ==================================================
// CONFIG / LOGGING
// ==================================================
const DEBUG = true;
const log = (...args) => DEBUG && console.error('[OCR]', ...args);

// ==================================================
// GRID CONSTANTS (3840x2160 CALIBRATION)
// ==================================================
const GRID_L_X1 = 0.526;
const GRID_L_X2 = 0.556;
const GRID_R_X1 = 0.630;
const GRID_R_X2 = 0.660;
const GRID_ROW_Y = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.020;

// ==================================================
// SINGLETON TESSERACT WORKER
// ==================================================
let worker = null;

async function getWorker() {
  if (!worker) {
    log('Creating Tesseract worker');
    worker = await createWorker('eng', 1, {
      logger: m => m && m.status && log(m.status),
    });
  }
  return worker;
}

// ==================================================
// GRID CELL CROP
// ==================================================
async function cropNumberCell(src, x1, x2, yC, halfH, w, h, label) {
  const left = Math.round(w * x1);
  const top = Math.max(0, Math.round(h * (yC - halfH)));
  const width = Math.round(w * (x2 - x1));
  const height = Math.round(h * halfH * 2);

  log('Cropping', label, { left, top, width, height });

  const out = join(tmpdir(), `cell_${label}_${Date.now()}.png`);

  await sharp(src)
    .extract({ left, top, width, height })
    .greyscale()
    .threshold(100)
    .negate()
    .resize({ width: width * 8, kernel: 'nearest' })
    .toFile(out);

  return out;
}

// ==================================================
// OCR NUMBER CELL
// ==================================================
async function ocrCell(worker, imgPath) {
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  const res = await worker.recognize(imgPath);
  const raw = res.data.text.replace(/\D/g, '');

  log('OCR raw:', raw);

  for (const m of raw.match(/\d{2,3}/g) || []) {
    const n = parseInt(m, 10);
    if (n >= 50 && n <= 99) return n;
  }
  return null;
}

// ==================================================
// NAME OCR
// ==================================================
async function extractName(src, w, h, worker) {
  const left = Math.floor(w * 0.45);
  const top = Math.floor(h * 0.12);
  const width = Math.floor(w * 0.27);
  const height = Math.floor(h * 0.13);

  const tmp = join(tmpdir(), `name_${Date.now()}.png`);

  await sharp(src)
    .extract({ left, top, width, height })
    .greyscale()
    .normalise()
    .resize({ width: width * 2 })
    .toFile(tmp);

  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '',
  });

  const res = await worker.recognize(tmp);
  try { unlinkSync(tmp); } catch {}

  log('Name OCR raw:', res.data.text);

  const words = res.data.text
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);

  return words.slice(0, 2).join(' ') || null;
}

// ==================================================
// POSITION + ARCHETYPE OCR
// ==================================================
async function extractPositionArchetype(src, w, h, archetypes, worker) {
  const left = Math.round(w * 0.68);
  const top = Math.round(h * 0.12);
  const width = Math.round(w * 0.16);
  const height = Math.round(h * 0.20);

  log('Meta crop box', { left, top, width, height });

  const tmp = join(tmpdir(), `meta_${Date.now()}.png`);

  await sharp(src)
    .extract({ left, top, width, height })
    .greyscale()
    .normalise()
    .resize({ width: width * 3 })
    .toFile(tmp);

  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '',
  });

  const res = await worker.recognize(tmp);
  try { unlinkSync(tmp); } catch {}

  log('Meta OCR raw:', res.data.text);

  const text = res.data.text.toUpperCase();

  const POSITIONS = [
    'QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S','ATH',
    'RT','LT','LG','RG','FS','SS'
  ];

  const position = POSITIONS.find(p => text.includes(p)) || null;
  const archetype = archetypes.find(a => text.includes(a.toUpperCase())) || null;

  return { position, archetype };
}

// ==================================================
// MAIN ENTRY POINT
// ==================================================
export async function performOCR(imageUrl) {
  console.error('[OCR] performOCR CALLED');
  console.error('[OCR] Image URL:', imageUrl);

  const rawPath = join(tmpdir(), `raw_${Date.now()}.png`);
  const resp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  writeFileSync(rawPath, resp.data);

  const meta = await sharp(rawPath).metadata();
  log('Image metadata:', meta);

  const { width: w, height: h } = meta;

  const archetypes =
    (await supabase.from('archetypes').select('archetype'))
      .data?.map(a => a.archetype) || [];

  const worker = await getWorker();
  const values = [];
  const cells = [];

  try {
    for (let r = 0; r < 5; r++) {
      const y = GRID_ROW_Y[r];
      cells.push(await cropNumberCell(rawPath, GRID_L_X1, GRID_L_X2, y, GRID_ROW_HALF, w, h, `R${r}L`));
      cells.push(await cropNumberCell(rawPath, GRID_R_X1, GRID_R_X2, y, GRID_ROW_HALF, w, h, `R${r}R`));
    }

    for (const c of cells) values.push(await ocrCell(worker, c));
    log('Final grid values:', values);

    const name = await extractName(rawPath, w, h, worker);
    const { position, archetype } =
      await extractPositionArchetype(rawPath, w, h, archetypes, worker);

    return { values, name, position, archetype };

  } finally {
    for (const c of cells) try { unlinkSync(c); } catch {}
    try { unlinkSync(rawPath); } catch {}
  }
}

// ==================================================
// GRID VALUE MAPPER
// ==================================================
export function mapGridValues(values, attrOrder) {
  const attrs = {};
  const missing = [];

  if (!Array.isArray(values) || !Array.isArray(attrOrder)) {
    return { attrs, missing: attrOrder || [] };
  }

  for (let i = 0; i < attrOrder.length; i++) {
    const v = values[i];
    if (typeof v === 'number') attrs[attrOrder[i]] = v;
    else missing.push(attrOrder[i]);
  }

  log('Mapped attrs:', attrs);
  log('Missing attrs:', missing);

  return { attrs, missing };
}
