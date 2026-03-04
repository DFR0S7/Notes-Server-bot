import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

// Maps OCR text (uppercase) → abbreviation used in config
const NAME_MAP = {
  'AWARENESS':            'AWR',
  'SPEED':                'SPD',
  'ACCELERATION':         'ACC',
  'AGILITY':              'AGI',
  'STRENGTH':             'STR',
  'JUMP':                 'JMP',
  'STAMINA':              'STA',
  'INJURY':               'INJ',
  'THROW POWER':          'THP',
  'SHORT ACCURACY':       'SAC',
  'MID ACCURACY':         'MAC',
  'DEEP ACCURACY':        'DAC',
  'THROW ON RUN':         'TOR',
  'PLAY ACTION':          'PAC',
  'BREAK SACK':           'BSK',
  'CARRYING':             'CAR',
  'CATCHING':             'CTH',
  'CATCH IN TRAFFIC':     'CIT',
  'SPECTACULAR CATCH':    'SPC',
  'ROUTE RUNNING':        'RTE',
  'SHORT ROUTE':          'SRR',
  'MED ROUTE':            'MRR',
  'DEEP ROUTE':           'DRR',
  'RELEASE':              'RLS',
  'BREAK TACKLE':         'BTK',
  'TRUCKING':             'TRK',
  'ELUSIVENESS':          'ELU',
  'BC VISION':            'BCV',
  'SPIN MOVE':            'SPM',
  'JUKE MOVE':            'JKM',
  'CHANGE OF DIRECTION':  'COD',
  'STIFF ARM':            'SFA',
  'TACKLE':               'TAK',
  'HIT POWER':            'HPW',
  'PURSUIT':              'PUR',
  'PLAY RECOGNITION':     'PRC',
  'MAN COVERAGE':         'MCV',
  'ZONE COVERAGE':        'ZCV',
  'PRESS':                'PRS',
  'POWER MOVES':          'POW',
  'FINESSE MOVES':        'FNS',
  'BLOCK SHEDDING':       'BSH',
  'PASS BLOCK':           'PBK',
  'RUN BLOCK':            'RBK',
  'PASS BLOCK POWER':     'PBP',
  'PASS BLOCK FINESSE':   'PBF',
  'RUN BLOCK POWER':      'RBP',
  'RUN BLOCK FINESSE':    'RBF',
  'LEAD BLOCK':           'LBK',
  'IMPACT BLOCKING':      'IBK',
  'KICK POWER':           'KPW',
  'KICK ACCURACY':        'KAC',
  'KICK RETURN':          'KRT',
};

const ALL_NAMES = Object.keys(NAME_MAP);

// Reverse map: abbreviation → OCR name (for filtering by config)
const ABBREV_TO_OCR = Object.fromEntries(
  Object.entries(NAME_MAP).map(([ocr, abbrev]) => [abbrev, ocr])
);

export async function performOCR(imageUrl) {
  const tmpRaw  = join(tmpdir(), 'recruit_raw_' + Date.now() + '.png');
  const tmpCrop = join(tmpdir(), 'recruit_crop_' + Date.now() + '.png');

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  // Crop left 40% off to remove Scout panel
  const metadata  = await sharp(tmpRaw).metadata();
  const cropLeft  = Math.floor(metadata.width * 0.40);
  const cropWidth = metadata.width - cropLeft;

  await sharp(tmpRaw)
    .extract({ left: cropLeft, top: 0, width: cropWidth, height: metadata.height })
    .toFile(tmpCrop);

  const worker = await createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(tmpCrop);
    console.log('OCR raw output:\n', text);
    return text;
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpRaw); } catch {}
    try { unlinkSync(tmpCrop); } catch {}
  }
}

export function parseAttributes(ocrText, configuredAttrs = null) {
  const attrs = {};
  const lines  = ocrText.split('\n').map(l => l.trim()).filter(Boolean);

  // Sort longest first so BREAK TACKLE is matched before TACKLE
  const targetNames = (configuredAttrs
    ? configuredAttrs.map(a => ABBREV_TO_OCR[a]).filter(Boolean)
    : ALL_NAMES).sort((a, b) => b.length - a.length);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim();

    // Find known attribute names in this line
    // Use negative lookbehind so TACKLE won't match inside BREAK TACKLE
    const foundNames = targetNames.filter(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = name === 'TACKLE'
        ? /(?<!BREAK )TACKLE(?! )/.test(line)
        : new RegExp('(?<![A-Z])' + escaped + '(?![A-Z])').test(line);
      return pattern;
    });
    if (foundNames.length === 0) continue;

    // Next line should have the numbers
    const nextLine = (lines[i + 1] || '').trim();
    const numbers  = nextLine.match(/\b\d{2,3}\b/g);
    if (!numbers) continue;

    // Sort names left to right by position in line
    const sortedNames = foundNames
      .map(name => ({ name, pos: line.indexOf(name) }))
      .sort((a, b) => a.pos - b.pos);

    sortedNames.forEach((entry, idx) => {
      if (numbers[idx] !== undefined) {
        const value = parseInt(numbers[idx]);
        if (value >= 1 && value <= 99) {
          attrs[NAME_MAP[entry.name]] = value;
        }
      }
    });

    i++;
  }

  console.log('Parsed attributes:', attrs);
  return attrs;
}
