import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const ABBREV_MAP = {
  SPD: 'Speed',         ACC: 'Acceleration',  STR: 'Strength',      AGI: 'Agility',
  AWR: 'Awareness',     JMP: 'Jump',          THP: 'Throw Power',
  SAC: 'Short Acc',     MAC: 'Mid Acc',       DAC: 'Deep Acc',
  PAC: 'Play Action',   CAR: 'Carrying',      CTH: 'Catching',
  BTK: 'Break Tackle',  TRK: 'Trucking',      ELU: 'Elusiveness',
  BCV: 'BC Vision',     SPM: 'Spin Move',     JKM: 'Juke Move',
  COD: 'Change of Dir', TAK: 'Tackle',        POW: 'Power Moves',
  ZCV: 'Zone Cov',      MCV: 'Man Cov',       PRS: 'Press',
  PBK: 'Pass Block',    RBK: 'Run Block',     RLS: 'Release',
  IBK: 'Impact Block',  KPW: 'Kick Power',    KAC: 'Kick Accuracy',
};

export async function performOCR(imageUrl) {
  const tmpPath = join(tmpdir(), `recruit_${Date.now()}.png`);
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpPath, Buffer.from(response.data));

  const worker = await createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(tmpPath);
    return text;
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpPath); } catch {}
  }
}

export function parseAttributes(ocrText) {
  const attrs = {};
  const lines = ocrText.split('\n');

  for (const line of lines) {
    const match = line.match(/([A-Za-z\s]{2,20})[:\s]+(\d{2,3})/);
    if (!match) continue;

    const rawKey = match[1].trim().toUpperCase();
    const value  = parseInt(match[2], 10);
    if (value < 1 || value > 99) continue;

    const key = ABBREV_MAP[rawKey]
      ?? Object.values(ABBREV_MAP).find(v => v.toUpperCase() === rawKey)
      ?? rawKey;

    attrs[key] = value;
  }

  return attrs;
}
