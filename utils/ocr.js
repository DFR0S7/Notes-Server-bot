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
  'POWER MOVES':          'PMV',
  'FINESSE MOVES':        'FMV',
  'BLOCK SHEDDING':       'BSH',
  'PASS BLOCK':           'PBK',
  'RUN BLOCK':            'RBK',
  'PASS BLOCK POWER':     'PBP',
  'PASS BLOCK FINESSE':   'PBF',
  'RUN BLOCK POWER':      'RBP',
  'RUN BLOCK FINESSE':    'RBF',
  'LEAD BLOCK':           'LBK',
  'IMPACT BLOCKING':      'IBL',
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
  const tmpRaw = join(tmpdir(), 'recruit_raw_' + Date.now() + '.png');

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const metadata = await sharp(tmpRaw).metadata();
  const w = metadata.width;
  const h = metadata.height;

  // Split into left column (44-57%) and right column (60.5-73%)
  const leftStart  = Math.floor(w * 0.44);
  const leftWidth  = Math.floor(w * 0.13);
  const rightStart = Math.floor(w * 0.605);
  const rightWidth = Math.floor(w * 0.125);

  const tmpLeft  = join(tmpdir(), 'recruit_left_'  + Date.now() + '.png');
  const tmpRight = join(tmpdir(), 'recruit_right_' + Date.now() + '.png');

  await Promise.all([
    sharp(tmpRaw).extract({ left: leftStart,  top: 0, width: leftWidth,  height: h }).greyscale().normalise().toFile(tmpLeft),
    sharp(tmpRaw).extract({ left: rightStart, top: 0, width: rightWidth, height: h }).greyscale().normalise().toFile(tmpRight),
  ]);

  const worker = await createWorker('eng');
  try {
    const [leftResult, rightResult] = await Promise.all([
      worker.recognize(tmpLeft),
      worker.recognize(tmpRight),
    ]);
    const combined = leftResult.data.text + '\n' + rightResult.data.text;
    console.log('OCR raw output:\n', combined);
    return { text: combined };
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

  const targetNames = (configuredAttrs
    ? configuredAttrs.map(a => ABBREV_TO_OCR[a]).filter(Boolean)
    : ALL_NAMES).sort((a, b) => b.length - a.length);

  for (let i = 0; i < lines.length; i++) {
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
      .replace(/CHANGEOFDIR\w*/g, 'CHANGE OF DIRECTION')
      .replace(/BLOCKSHED\w*/g, 'BLOCK SHEDDING')
      .replace(/PLAYRECOG\w*/g, 'PLAY RECOGNITION')
      .replace(/PASSBLOCKPOWER/g, 'PASS BLOCK POWER')
      .replace(/PASSBLOCKFINESSE/g, 'PASS BLOCK FINESSE')
      .replace(/RUNBLOCKPOWER/g, 'RUN BLOCK POWER')
      .replace(/RUNBLOCKFINESSE/g, 'RUN BLOCK FINESSE')
      .replace(/PASSBLOCK(?!ING)\b/g, 'PASS BLOCK')
      .replace(/RUNBLOCK(?!ING)\b/g, 'RUN BLOCK')
      .replace(/IMPACTBLOCKING/g, 'IMPACT BLOCKING')
      .replace(/MANCOVERAGE/g, 'MAN COVERAGE')
      .replace(/ZONECOVERAGE/g, 'ZONE COVERAGE')
      .replace(/BREAKTACKLE/gi, 'BREAK TACKLE')
      .replace(/JUKEMOVE/gi, 'JUKE MOVE')
      .replace(/SPINMOVE/gi, 'SPIN MOVE')
      .replace(/BCVISION/gi, 'BC VISION')
      .replace(/SHORTROUTE/g, 'SHORT ROUTE')
      .replace(/MEDROUTE/g, 'MED ROUTE')
      .replace(/DEEPROUTE/g, 'DEEP ROUTE')
      .replace(/\s+/g, ' ')
      .trim();

    const foundNames = targetNames.filter(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = name === 'TACKLE'
        ? /(?<!BREAK )TACKLE/.test(line)
        : new RegExp('(?<![A-Z])' + escaped + '(?![A-Z])').test(line);
      return pattern;
    });
    if (foundNames.length === 0) continue;

    // Try next line for numbers, fall back to inline numbers
    // Correct known OCR misreads across different team color schemes
    const rawNext   = (lines[i + 1] || '').trim();
    const corrected = rawNext
      .replace(/\bEb\b/gi, '91')
      .replace(/\beb\s+et\b/gi, '91')
      .replace(/\boT\b/gi, '91')
      .replace(/\blg\b/gi, '78')
      .replace(/\bIg\b/gi, '78')
      .replace(/^8$/, '84')
      .replace(/\bBY\b/gi, '81')
      .replace(/\bELLE\b/gi, '74')
      .replace(/\bB(\d{2})\b/, '$1')   // B20 -> 20... but B82 -> 82
      .replace(/^[A-Za-z]+(\d{2,3})$/, '$1')  // leading letters: B20->20, ED79->79
      .replace(/^(\d{2,3})[^0-9].*$/, '$1')   // trailing junk: "80 |" -> "80"
      .replace(/(\d{2})[°.:]+$/, '$1');        // trailing punctuation
    const nextNums   = corrected.match(/\b\d{2,3}\b/g);
    const cleanCurrent = lines[i].replace(/(\d{2,3})[°.:]+/, '$1');
    const inlineNums = cleanCurrent.match(/\b\d{2,3}\b/g);
    // If next line gave no valid numbers, peek two lines ahead
    const nextLine2  = (lines[i + 2] || '').trim().replace(/^[A-Za-z]+(\d{2,3})$/, '$1').replace(/^(\d{2,3})[^0-9].*$/, '$1');
    const peekNums   = nextLine2.match(/\b\d{2,3}\b/g);
    const numbers    = (nextNums && nextNums.length > 0) ? nextNums
                     : (inlineNums && inlineNums.length > 0) ? inlineNums
                     : peekNums;
    if (!numbers) continue;

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
