import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

/* ─────────────────────────────────────────────
   DEBUG FLAG
───────────────────────────────────────────── */
const DEBUG_OCR = true;
const log = (...args) => DEBUG_OCR && console.log('[OCR]', ...args);
const warn = (...args) => console.warn('[OCR]', ...args);
const error = (...args) => console.error('[OCR]', ...args);

/* ─────────────────────────────────────────────
   SHARP LOW‑RAM CONFIG
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
    log('Creating Tesseract worker...');
    workerInstance = await createWorker('eng', 1, {
      logger: m => DEBUG_OCR && m.status && log('Tesseract:', m.status),
    });
    log('Tesseract worker ready');
  }
  return workerInstance;
}

async function acquireWorker() {
  if (!workerBusy) {
    workerBusy = true;
    log('Worker acquired immediately');
    return getWorker();
  }

  log('Worker busy, queued');
  return new Promise(res => workerQueue.push(res)).then(() => {
    log('Worker dequeued');
    return getWorker();
  });
}

function releaseWorker() {
  if (workerQueue.length) {
    log('Releasing worker to queued job');
    workerQueue.shift()();
  } else {
    log('Worker released (idle)');
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
async function cropCellBuffer(base, x1, x2, yC, half, w, h, label) {
  const left = Math.round(w * x1);
  const top = Math.max(0, Math.round(h * (yC - half)));
  const width = Math.round(w * (x2 - x1));
  const height = Math.round(h * half * 2);

  log(`Cropping ${label}`, { left, top, width, height });

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid crop size for ${label}`);
  }

  return base
    .clone()
    .extract({ left, top, width, height })
    .greyscale()
    .threshold(100)
    .negate()
    .resize({ width: width * 4, kernel: 'nearest' })
    .toBuffer();
}

async function ocrNumber(worker, buffer, label) {
  log(`Running OCR on ${label}, buffer size=${buffer.length}`);

  const res = await worker.recognize(buffer);
  const text = res.data.text || '';

  log(`Raw OCR [${label}]: "${text.replace(/\n/g, ' ')}"`);

  const raw = text.replace(/\D/g, '');
  const matches = raw.match(/\d{2,3}/g) || [];

  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n >= 50 && n <= 99) {
      log(`Accepted value ${n} from "${m}"`);
      return n;
    }
    if (m.length === 3) {
      const a = parseInt(m.slice(1), 10);
      const b = parseInt(m[0] + m[2], 10);
      if (a >= 50 && a <= 99) return a;
      if (b >= 50 && b <= 99) return b;
    }
  }

  log(`No valid number found for ${label}`);
  return null;
}

/* ─────────────────────────────────────────────
   MAIN OCR ENTRY
───────────────────────────────────────────── */
export async function performOCR(imageUrl) {
  log('Starting OCR for URL:', imageUrl);

  const tmpRaw = join(tmpdir(), `ocr_${Date.now()}.png`);

  try {
    log('Downloading image...');
    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    log(`Downloaded ${resp.data.byteLength} bytes`);

    await sharp(resp.data)
      .resize({ width: 1920, kernel: 'lanczos3' })
      .toFile(tmpRaw);

    const base = sharp(tmpRaw);
    const meta = await base.metadata();

    log('Image metadata:', meta);

    if (!meta.width || !meta.height) {
      throw new Error('Invalid image metadata');
    }

    const w = meta.width;
    const h = meta.height;

    const worker = await acquireWorker();
    const values = [];

    try {
      for (let r = 0; r < 5; r++) {
        const y = GRID_ROW_Y[r];
        for (const [side, x1, x2] of [
          ['L', GRID_L_X1, GRID_L_X2],
          ['R', GRID_R_X1, GRID_R_X2],
        ]) {
          const label = `R${r + 1}${side}`;
          try {
            const buf = await cropCellBuffer(
              base,
              x1,
              x2,
              y,
              GRID_ROW_HALF,
              w,
              h,
              label
            );
            const val = await ocrNumber(worker, buf, label);
            values.push(val);
          } catch (e) {
            error(`Cell ${label} failed:`, e.message);
            values.push(null);
          }
        }
      }
    } finally {
      releaseWorker();
    }

    log('Final grid values:', values);
    return { values };
  } catch (e) {
    error('OCR FAILED:', e.stack || e.message);
    return { values: null, error: e.message };
  } finally {
    try {
      unlinkSync(tmpRaw);
    } catch {}
    log('OCR complete, temp cleaned up');
  }
}

/* ─────────────────────────────────────────────
   GRID MAP HELPER
───────────────────────────────────────────── */
export function mapGridValues(values, order) {
  log('Mapping grid values:', values, order);

  const attrs = {};
  const missing = [];

  if (!Array.isArray(values) || values.length !== 10) {
    warn('Invalid values array');
    return { attrs: {}, missing: order ?? [] };
  }

  for (let i = 0; i < 10; i++) {
    const v = values[i];
    if (typeof v === 'number' && v >= 50 && v <= 99) {
      attrs[order[i]] = v;
    } else {
      missing.push(order[i]);
    }
  }

  log('Mapped attrs:', attrs, 'Missing:', missing);
  return { attrs, missing };
}
