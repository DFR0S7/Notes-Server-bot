import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

/* ─────────────────────────────────────────────────────────────
   GLOBAL SHARP SETTINGS (LOW RAM)
───────────────────────────────────────────────────────────── */
sharp.cache(false);

/* ─────────────────────────────────────────────────────────────
   SINGLETON TESSERACT WORKER
───────────────────────────────────────────────────────────── */
let worker = null;
let workerBusy = false;
const workerQueue = [];

async function getWorker() {
  if (!worker) {
    worker = await createWorker('eng', 1, { logger: () => {} });
  }
  return worker;
}

async function acquireWorker() {
  if (!workerBusy) {
    workerBusy = true;
    return getWorker();
  }
  return new Promise(res => workerQueue.push(res)).then(getWorker);
}

function releaseWorker() {
  if (workerQueue.length) workerQueue.shift()();
  else workerBusy = false;
}

/* ─────────────────────────────────────────────────────────────
   GRID CONSTANTS
───────────────────────────────────────────────────────────── */
const GRID_L_X1 = 0.526;
const GRID_L_X2 = 0.556;
const GRID_R_X1 = 0.630;
const GRID_R_X2 = 0.660;
const GRID_ROW_Y = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.018;

/* ─────────────────────────────────────────────────────────────
   TEXT MATCH HELPERS
───────────────────────────────────────────────────────────── */
function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );

  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);

  return dp[a.length][b.length];
}

function bestMatch(raw, list, max = 3) {
  if (!raw) return null;
  const norm = normalise(raw);
  let best = null, dist = max + 1;

  for (const v of list) {
    const d = levenshtein(norm, normalise(v));
    if (d < dist) { dist = d; best = v; }
  }
  return dist <= max ? best : null;
}

/* ─────────────────────────────────────────────────────────────
   OCR HELPERS (BUFFER BASED)
───────────────────────────────────────────────────────────── */
async function cropCellBuffer(base, x1, x2, yC, half, w, h) {
  return base.clone()
    .extract({
      left: Math.round(w * x1),
      top: Math.max(0, Math.round(h * (yC - half))),
      width: Math.round(w * (x2 - x1)),
      height: Math.round(h * half * 2),
    })
    .greyscale()
    .threshold(100)
    .negate()
    .resize({ width: Math.round(w * (x2 - x1)) * 4, kernel: 'nearest' })
    .toBuffer();
}

async function ocrNumber(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  const raw = data.text.replace(/\D/g, '');
  const matches = raw.match(/\d{2,3}/g) || [];

  for (const m of matches) {
    const n = parseInt(m);
    if (n >= 50 && n <= 99) return n;
    if (m.length === 3) {
      const a = parseInt(m.slice(1));
      const b = parseInt(m[0] + m[2]);
      if (a >= 50 && a <= 99) return a;
      if (b >= 50 && b <= 99) return b;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
   MAIN OCR PIPELINE
───────────────────────────────────────────────────────────── */
export async function performOCR(imageUrl) {
  const tmpRaw = join(tmpdir(), `recruit_${Date.now()}.png`);

  const imageData = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000
  });

  await sharp(imageData.data)
    .resize({ width: 1920, kernel: 'lanczos3' })
    .toFile(tmpRaw);

