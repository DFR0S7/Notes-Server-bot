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
  'MEDIUM ACCURACY':      'MAC',
  'DEEP ACCURACY':        'DAC',
  'THROW ON RUN':         'TOR',
  'UNDER PRESSURE':       'TUP',
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

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const metadata  = await sharp(tmpRaw).metadata();
  const w         = metadata.width;
  const h         = metadata.height;

  // Split into left column (47-57%) and right column (57-67%) to OCR each cleanly
  const leftStart  = Math.floor(w * 0.47);
  const leftWidth  = Math.floor(w * 0.10);
  const rightStart = Math.floor(w * 0.57);
  const rightWidth = Math.floor(w * 0.10);

  const tmpLeft  = join(tmpdir(), 'recruit_left_'  + Date.now() + '.png');
  const tmpRight = join(tmpdir(), 'recruit_right_' + Date.now() + '.png');

  await Promise.all([
    sharp(tmpRaw).extract({ left: leftStart,  top: 0, width: leftWidth,  height: h }).toFile(tmpLeft),
    sharp(tmpRaw).extract({ left: rightStart, top: 0, width: rightWidth, height: h }).toFile(tmpRight),
  ]);

  const worker = await createWorker('eng');
  try {
    const [leftResult, rightResult] = await Promise.all([
      worker.recognize(tmpLeft),
      worker.recognize(tmpRight),
    ]);
    const combined = leftResult.data.text + '\n' + rightResult.data.text;
    console.log('OCR raw output:\n', combined);
    return combined;
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpRaw);   } catch {}
    try { unlinkSync(tmpLeft);  } catch {}
    try { unlinkSync(tmpRight); } catch {}
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
    // Clean line: remove non-alpha, collapse spaces, fix common OCR spacing errors
    const raw  = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim();
    const line = raw
      .replace(/THROWPOWER/g, 'THROW POWER')
      .replace(/SHORTACCURACY/g, 'SHORT ACCURACY')
      .replace(/MIDACCURACY/g, 'MID ACCURACY')
      .replace(/MEDIUMACCURACY/g, 'MEDIUM ACCURACY')
      .replace(/DEEPACCURACY/g, 'DEEP ACCURACY')
      .replace(/THROWONRUN/g, 'THROW ON RUN')
      .replace(/UNDERPRESSURE/g, 'UNDER PRESSURE')
      .replace(/PLAYACTION/g, 'PLAY ACTION')
      .replace(/BREAKSACK/g, 'BREAK SACK')
      .replace(/CATCHINTRAFFIC/g, 'CATCH IN TRAFFIC')
      .replace(/SPECTACULARCATCH/g, 'SPECTACULAR CATCH')
      .replace(/ROUTERUNNING/g, 'ROUTE RUNNING')
      .replace(/SHORTROUTE/g, 'SHORT ROUTE')
      .replace(/MEDROUTE/g, 'MED ROUTE')
      .replace(/DEEPROUTE/g, 'DEEP ROUTE')
      .replace(/BREAKTACKLE/g, 'BREAK TACKLE')
      .replace(/BCVISION/g, 'BC VISION')
      .replace(/SPINMOVE/g, 'SPIN MOVE')
      .replace(/JUKEMOVE/g, 'JUKE MOVE')
      .replace(/CHANGEOFDIRECTION/g, 'CHANGE OF DIRECTION')
      .replace(/STIFFARM/g, 'STIFF ARM')
      .replace(/HITPOWER/g, 'HIT POWER')
      .replace(/PLAYRECOGNITION/g, 'PLAY RECOGNITION')
      .replace(/MANCOVERAGE/g, 'MAN COVERAGE')
      .replace(/ZONECOVERAGE/g, 'ZONE COVERAGE')
      .replace(/POWERMOVES/g, 'POWER MOVES')
      .replace(/FINESSEMOVES/g, 'FINESSE MOVES')
      .replace(/BLOCKSHEDDING/g, 'BLOCK SHEDDING')
      .replace(/PASSBLOCKPOWER/g, 'PASS BLOCK POWER')
      .replace(/PASSBLOCKFINESSE/g, 'PASS BLOCK FINESSE')
      .replace(/RUNBLOCKPOWER/g, 'RUN BLOCK POWER')
      .replace(/RUNBLOCKFINESSE/g, 'RUN BLOCK FINESSE')
      .replace(/PASSBLOCK/g, 'PASS BLOCK')
      .replace(/RUNBLOCK/g, 'RUN BLOCK')
      .replace(/LEADBLOCK/g, 'LEAD BLOCK')
      .replace(/IMPACTBLOCKING/g, 'IMPACT BLOCKING')
      .replace(/KICKPOWER/g, 'KICK POWER')
      .replace(/KICKACCURACY/g, 'KICK ACCURACY')
      .replace(/KICKRETURN/g, 'KICK RETURN')
      .replace(/\s+/g, ' ')
      .trim();

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
