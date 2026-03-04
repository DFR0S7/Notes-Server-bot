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
  const tmpRaw  = join(tmpdir(), 'recruit_raw_' + Date.now() + '.png');

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const metadata  = await sharp(tmpRaw).metadata();
  const w         = metadata.width;
  const h         = metadata.height;

  // Split into left column (45-58.5%) and right column (58.5-72%) to OCR each cleanly
  const leftStart  = Math.floor(w * 0.45);
  const leftWidth  = Math.floor(w * 0.135);
  const rightStart = Math.floor(w * 0.585);
  const rightWidth = Math.floor(w * 0.135);

  // Name region: first name (smaller) + last name (larger) stacked in header
  const nameStart = Math.floor(w * 0.44);
  const nameWidth = Math.floor(w * 0.18);
  const nameY1    = Math.floor(h * 0.166);  // ~360px at 2160h
  const nameY2    = Math.floor(h * 0.268);  // ~580px at 2160h

  const attrTopLeft  = Math.floor(h * 0.420); // ~907px - clears all header noise for left col
  const attrTopRight = Math.floor(h * 0.470); // ~1015px - clears 0/50 timer for right col

  const tmpName      = join(tmpdir(), 'recruit_name_'       + Date.now() + '.png');
  const tmpLeft      = join(tmpdir(), 'recruit_left_'       + Date.now() + '.png');
  const tmpRight     = join(tmpdir(), 'recruit_right_'      + Date.now() + '.png');
  const tmpLeftAttr  = join(tmpdir(), 'recruit_left_attr_'  + Date.now() + '.png');
  const tmpRightAttr = join(tmpdir(), 'recruit_right_attr_' + Date.now() + '.png');

  await Promise.all([
    sharp(tmpRaw)
      .extract({ left: nameStart, top: nameY1, width: nameWidth, height: nameY2 - nameY1 })
      .greyscale().normalise().toFile(tmpName),
    sharp(tmpRaw)
      .extract({ left: leftStart, top: 0, width: leftWidth, height: h })
      .greyscale().normalise().toFile(tmpLeft),
    sharp(tmpRaw)
      .extract({ left: rightStart, top: 0, width: rightWidth, height: h })
      .greyscale().normalise().toFile(tmpRight),
    sharp(tmpRaw)
      .extract({ left: leftStart, top: attrTopLeft, width: leftWidth, height: h - attrTopLeft })
      .greyscale().normalise().toFile(tmpLeftAttr),
    sharp(tmpRaw)
      .extract({ left: rightStart, top: attrTopRight, width: rightWidth, height: h - attrTopRight })
      .greyscale().normalise().toFile(tmpRightAttr),
  ]);

  const textWorker   = await createWorker('eng');
  const digitsWorker = await createWorker('eng');
  try {
    await digitsWorker.setParameters({ tessedit_char_whitelist: '0123456789' });

    const [nameResult, leftText, rightText, leftNums, rightNums] = await Promise.all([
      textWorker.recognize(tmpName),
      textWorker.recognize(tmpLeft),
      textWorker.recognize(tmpRight),
      digitsWorker.recognize(tmpLeftAttr),
      digitsWorker.recognize(tmpRightAttr),
    ]);

    // Parse name: take only lines that are all caps letters, pick the two longest
    const nameLines = nameResult.data.text
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[A-Z]{2,}$/.test(l))
      .sort((a, b) => b.length - a.length)
      .slice(0, 2)
      .reverse();
    const recruitName = nameLines.join(' ') || null;

    // Merge strategy: extract attribute names in order from text pass,
    // extract all 2-3 digit numbers in order from digits pass,
    // zip them together
    const extractNamesInOrder = (textOut) => {
      const lines = textOut.split('\n').map(l => l.trim()).filter(Boolean);
      const found = [];
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim()
          .replace(/THROWPOWER/g, 'THROW POWER')
          .replace(/SHORTACCURACY/g, 'SHORT ACCURACY')
          .replace(/MIDACCURACY/g, 'MID ACCURACY')
          .replace(/MEDIUMACCURACY/g, 'MEDIUM ACCURACY')
          .replace(/DEEPACCURACY/g, 'DEEP ACCURACY')
          .replace(/THROWONRUN/g, 'THROW ON RUN')
          .replace(/UNDERPRESSURE/g, 'UNDER PRESSURE')
          .replace(/BREAKSACK/g, 'BREAK SACK')
          .replace(/CATCHINTRAFFIC/g, 'CATCH IN TRAFFIC')
          .replace(/SPECTACULARCATCH/g, 'SPECTACULAR CATCH')
          .replace(/CHANGEOFDIR\w*/g, 'CHANGE OF DIRECTION')
          .replace(/BLOCKSHED\w*/g, 'BLOCK SHEDDING')
          .replace(/PLAYRECOG\w*/g, 'PLAY RECOGNITION')
          .replace(/PASSBLOCK(?!ING)\b/g, 'PASS BLOCK')
          .replace(/RUNBLOCK(?!ING)\b/g, 'RUN BLOCK')
          .replace(/PASSBLOCKPOWER/g, 'PASS BLOCK POWER')
          .replace(/PASSBLOCKFINESSE/g, 'PASS BLOCK FINESSE')
          .replace(/RUNBLOCKPOWER/g, 'RUN BLOCK POWER')
          .replace(/RUNBLOCKFINESSE/g, 'RUN BLOCK FINESSE')
          .replace(/IMPACTBLOCKING/g, 'IMPACT BLOCKING')
          .replace(/MANCOVERAGE/g, 'MAN COVERAGE')
          .replace(/ZONECOVERAGE/g, 'ZONE COVERAGE')
          .replace(/BREAKtackle/gi, 'BREAK TACKLE')
          .replace(/JUKEMOVE/gi, 'JUKE MOVE')
          .replace(/SPINMOVE/gi, 'SPIN MOVE')
          .replace(/BCVISION/gi, 'BC VISION')
          .replace(/BREAKTACKLE/gi, 'BREAK TACKLE')
          .replace(/SHORTROUTE/g, 'SHORT ROUTE')
          .replace(/MEDIUMROUTE/g, 'MEDIUM ROUTE')
          .replace(/DEEPROUTE/g, 'DEEP ROUTE')
          .replace(/RUNBLOCK$/g, 'RUN BLOCK');
        for (const name of ALL_NAMES) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = name === 'TACKLE'
            ? /(?<!BREAK )TACKLE/.test(raw)
            : new RegExp('(?<![A-Z])' + escaped + '(?![A-Z])').test(raw);
          if (pattern && !found.includes(name)) {
            found.push(name);
            break;
          }
        }
      }
      return found;
    };

    const extractNumbersInOrder = (numsOut) => {
      return (numsOut.match(/\b\d{2,3}\b/g) || []).map(Number).filter(n => n >= 1 && n <= 99);
    };

    const leftNames   = extractNamesInOrder(leftText.data.text);
    const rightNames  = extractNamesInOrder(rightText.data.text);
    const allLeftNums  = extractNumbersInOrder(leftNums.data.text);
    const allRightNums = extractNumbersInOrder(rightNums.data.text);

    console.log('Left names:', leftNames);
    console.log('Right names:', rightNames);
    console.log('Left raw digits:', allLeftNums);
    console.log('Right raw digits:', allRightNums);

    // Take only the last N numbers to match name count (trims leading stray digits)
    const leftDigits  = allLeftNums.slice(-leftNames.length);
    const rightDigits = allRightNums.slice(-rightNames.length);

    // Build combined text for logging, but also build attrs directly
    const directAttrs = {};
    leftNames.forEach((name, i)  => { if (leftDigits[i]  !== undefined) directAttrs[NAME_MAP[name]] = leftDigits[i]; });
    rightNames.forEach((name, i) => { if (rightDigits[i] !== undefined) directAttrs[NAME_MAP[name]] = rightDigits[i]; });

    const combined = leftText.data.text + '\n' + rightText.data.text;

    console.log('OCR name:', recruitName);
    console.log('OCR raw output:\n', combined);
    console.log('Direct attrs:', directAttrs);
    return { text: combined, name: recruitName, directAttrs };
  } finally {
    await textWorker.terminate();
    await digitsWorker.terminate();
    try { unlinkSync(tmpRaw);       } catch {}
    try { unlinkSync(tmpName);      } catch {}
    try { unlinkSync(tmpLeft);      } catch {}
    try { unlinkSync(tmpRight);     } catch {}
    try { unlinkSync(tmpLeftAttr);  } catch {}
    try { unlinkSync(tmpRightAttr); } catch {}
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

    // Next line should have the numbers — also check current raw line for inline numbers
    const nextLine   = (lines[i + 1] || '').trim();
    const inlineNums = lines[i].match(/\b\d{2,3}\b/g);
    const nextNums   = nextLine.match(/\b\d{2,3}\b/g);
    const numbers    = (nextNums && nextNums.length > 0) ? nextNums : inlineNums;
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
