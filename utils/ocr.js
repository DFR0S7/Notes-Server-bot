import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { supabase } from '../supabase.js';

/* ════════════════════════════════════════
   LOGGING
════════════════════════════════════════ */
const DEBUG = true;
const log = (...a) => DEBUG && console.error('[OCR]', ...a);

/* ════════════════════════════════════════
   GRID CONSTANTS (2160p calibrated)
════════════════════════════════════════ */
const GRID_L_X1 = 0.526;
const GRID_L_X2 = 0.556;
const GRID_R_X1 = 0.630;
const GRID_R_X2 = 0.660;
const GRID_ROW_Y = [0.4958, 0.5611, 0.6259, 0.6907, 0.7556];
const GRID_ROW_HALF = 0.018;

/* ════════════════════════════════════════
   SINGLETON WORKER
════════════════════════════════════════ */
let worker;
async function getWorker() {
  if (!worker) {
    log('Creating Tesseract worker');
    worker = await createWorker('eng', 1, {
      logger: m => m?.status && log('tesseract:', m.status),
    });
  }
  return worker;
}

/* ════════════════════════════════════════
   GRID CELL CROP
════════════════════════════════════════ */
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
    .resize({ width: width * 8, kernel: 'nearest' })
    .toFile(tmp);

  return tmp;
}

/* ════════════════════════════════════════
   OCR NUMBER
════════════════════════════════════════ */
async function ocrCell(worker, imgPath) {
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789',
  });

  const res = await worker.recognize(imgPath);
  const raw = res.data.text.replace(/\D/g, '');

  log('OCR cell raw:', raw);

  for (const m of raw.match(/\d{2,3}/g) || []) {
    const n = parseInt(m, 10);
    if (n >= 50 && n <= 99) return n;
  }
  return null;
}

/* ════════════════════════════════════════
   NAME OCR
════════════════════════════════════════ */
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
  unlinkSync(tmp);

