import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

/* ─────────────────────────────────────────────
   SHARP CONFIG (LOW RAM)
───────────────────────────────────────────── */
sharp.cache(false);

/* ─────────────────────────────────────────────
   SINGLETON TESSERACT WORKER
───────────────────────────────────────────── */
let workerInstance = null;
let workerBusy = false;
const workerQueue = [];

async function getWorker() {
  if (!workerInstance) {
    workerInstance = await createWorker('eng', 1, {
      logger: () => {},
    });
  }
  return workerInstance;
}

async function acquireWorker() {
  if (!workerBusy) {
    workerBusy = true;
    return getWorker();
  }
  return new Promise(res => workerQueue.push(res)).then(getWorker);
}

function releaseWorker() {
  if (workerQueue.length > 0) {
    workerQueue.shift()();
  } else {
    workerBusy = false;
  }
}

/* ─────────────────────────────────────────────
   GRID CONSTANTS
───────────────────────────────────────────── */
const GRID_L_X1 = 0.526;
const GRID_L_X2 = 0.556;
const GRID_R_X1 = 0.630;
const GRID_R_X2 = 0.660;
const GRID_ROW_Y = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.018;

/* ─────────────────────────────────────────────
   OCR HELPERS
───────────────────────────────────────────── */
async function cropCellBuffer(base, x1, x2, yC, half, w, h) {
  return base
    .clone()
    .extract({
      left: Math.round(w * x1),
      top: Math.max(0, Math.round(h * (yC - half))),
      width: Math.round(w * (x2 - x1)),
      height: Math.round(h * half * 2),
    })
    .greyscale()
    .threshold(100)
    .negate()
    .resize({
      width: Math.round(w * (x2 - x1)) * 4,
      kernel: 'nearest',
    })
    .toBuffer();
}

async function ocrNumber(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  const raw = data.text.replace(/\D/g, '');
  const matches = raw.match(/\d{2,3}/g) || [];

  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n >= 50 && n <= 99) return n;
    if (m.length === 3) {
      const a = parseInt(m.slice(1), 10);
      const b = parseInt(m[0] + m[2], 10);
      if (a >= 50 && a <= 99) return a;
      if (b >= 50 && b <= 99) return b;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────
   MAIN OCR FUNCTION
───────────────────────────────────────────── */
export async function performOCR(imageUrl) {
  const tmpRaw = join(tmpdir(), `recruit_${Date.now()}.png`);

  const imageData = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
  });

  await sharp(imageData.data)
    .resize({ width: 1920, kernel: 'lanczos3' })
    .toFile(tmpRaw);

  const base = sharp(tmpRaw);
  const { width: w, height: h } = await base.metadata();

  const worker = await acquireWorker();
  const values = [];

  try {
    for (let r = 0; r < 5; r++) {
      const y = GRID_ROW_Y[r];
      for (const [x1, x2] of [
        [GRID_L_X1, GRID_L_X2],
        [GRID_R_X1, GRID_R_X2],
      ]) {
        try {
          const buffer = await cropCellBuffer(base, x1, x2, y, GRID_ROW_HALF, w, h);
          values.push(await ocrNumber(worker, buffer));
        } catch {
          values.push(null);
        }
      }
    }
  } finally {
    releaseWorker();
    try {
      unlinkSync(tmpRaw);
    } catch {}
  }

  return { values };
}

/* ─────────────────────────────────────────────
   GRID MAPPING
───────────────────────────────────────────── */
export function mapGridValues(values, attrOrder) {
  const attrs = {};
  const missing = [];

  if (!Array.isArray(values) || values.length !== 10) {
    return { attrs: {}, missing: attrOrder ?? [] };
  }

  for (let i = 0; i < 10; i++) {
    const v = values[i];
    if (typeof v === 'number' && v >= 50 && v <= 99) {
      attrs[attrOrder[i]] = v;
    } else {
      missing.push(attrOrder[i]);
    }
  }

  return { attrs, missing };
}
