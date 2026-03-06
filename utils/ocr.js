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
  const tmpRaw  = join(tmpdir(), 'recruit_raw_'  + Date.now() + '.png');
  const tmpBox   = join(tmpdir(), 'recruit_box_'  + Date.now() + '.png');
  const tmpName  = join(tmpdir(), 'recruit_name_' + Date.now() + '.png');
  const tmpMeta  = join(tmpdir(), 'recruit_meta_' + Date.now() + '.png');

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpRaw, Buffer.from(response.data));

  const metadata = await sharp(tmpRaw).metadata();
  const w = metadata.width;
  const h = metadata.height;

  // Crop 1: attributes box (x: 45-72%, y: 40-78%)
  const boxLeft   = Math.floor(w * 0.45);
  const boxTop    = Math.floor(h * 0.40);
  const boxWidth  = Math.floor(w * 0.27);
  const boxHeight = Math.floor(h * 0.38);

  // Crop 2: name region (x: 45-72%, y: 12-25%)
  const nameLeft   = Math.floor(w * 0.45);
  const nameTop    = Math.floor(h * 0.12);
  const nameWidth  = Math.floor(w * 0.27);
  const nameHeight = Math.floor(h * 0.13);

  // Crop 3: position/archetype region (x: 68-85%, y: 12-28%)
  const metaLeft   = Math.floor(w * 0.68);
  const metaTop    = Math.floor(h * 0.12);
  const metaWidth  = Math.floor(w * 0.17);
  const metaHeight = Math.floor(h * 0.16);

  const nameValid = nameWidth >= 10 && nameHeight >= 10;
  const metaValid = metaWidth >= 10 && metaHeight >= 10;

  const cropPromises = [
    sharp(tmpRaw)
      .extract({ left: boxLeft, top: boxTop, width: boxWidth, height: boxHeight })
      .greyscale().normalise()
      .resize({ width: boxWidth * 2, kernel: 'cubic' })
      .toFile(tmpBox),
  ];

  if (nameValid) {
    cropPromises.push(
      sharp(tmpRaw)
        .extract({ left: nameLeft, top: nameTop, width: nameWidth, height: nameHeight })
        .greyscale().normalise()
        .resize({ width: nameWidth * 2, kernel: 'cubic' })
        .toFile(tmpName)
    );
  }

  if (metaValid) {
    cropPromises.push(
      sharp(tmpRaw)
        .extract({ left: metaLeft, top: metaTop, width: metaWidth, height: metaHeight })
        .greyscale().normalise()
        .resize({ width: metaWidth * 2, kernel: 'cubic' })
        .toFile(tmpMeta)
    );
  }

  await Promise.all(cropPromises);

  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
  });
  try {
    const [attrResult, nameResult, metaResult] = await Promise.all([
      worker.recognize(tmpBox),
      nameValid ? worker.recognize(tmpName) : Promise.resolve(null),
      metaValid ? worker.recognize(tmpMeta) : Promise.resolve(null),
    ]);

    const text = attrResult.data.text;
    console.log('OCR raw output:\n', text);

    // Extract name
    const SKIP_WORDS = /^(POSITION|ARCHETYPE|CLASS|HOMETOWN|ATH|QB|HB|WR|TE|OT|OG|DE|DT|LB|CB|SS|FS)$/;
    const recruitName = nameResult
      ? (nameResult.data.text
          .split('\n')
          .map(l => l.replace(/[^A-Za-z\s]/g, '').trim())
          .map(l => l.split(/\s+/)[0])
          .filter(w => w && /^[A-Z][A-Za-z]{2,}$/.test(w) && !SKIP_WORDS.test(w))
          .slice(0, 2)
          .join(' ') || null)
      : null;
    console.log('OCR name:', recruitName);

    // Extract position and archetype from meta region
    let recruitPosition = null;
    let recruitArchetype = null;

    if (metaResult) {
      const metaLines = metaResult.data.text
        .split('\n')
        .map(l => l.replace(/[|]/g, '').trim())
        .filter(l => l.length > 0);

      // Fetch all known archetypes from DB for fuzzy matching
      const { data: allArchetypes } = await supabase.from('archetypes').select('position, archetype');
      const knownArchetypes = allArchetypes?.map(a => a.archetype) || [];

      for (let i = 0; i < metaLines.length; i++) {
        const upper = metaLines[i].toUpperCase();
        if (upper.includes('POSITION') && metaLines[i + 1]) {
          recruitPosition = metaLines[i + 1].trim().split(/\s+/)[0].toUpperCase();
          // Validate against known positions
          const VALID_POSITIONS = ['QB','HB','WR','TE','OT','OG','C','DE','DT','LB','CB','S','ATH'];
          if (!VALID_POSITIONS.includes(recruitPosition)) recruitPosition = null;
        }
        if (upper.includes('ARCHETYPE') && metaLines[i + 1]) {
          const raw = metaLines[i + 1].trim();
          // Find best matching known archetype by checking if raw starts with it
          const match = knownArchetypes.find(a =>
            raw.toUpperCase().startsWith(a.toUpperCase())
          );
          recruitArchetype = match || null;
        }
      }
    }
    console.log('OCR position:', recruitPosition, '| archetype:', recruitArchetype);

    return { text, name: recruitName, position: recruitPosition, archetype: recruitArchetype };
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpRaw);  } catch {}
    try { unlinkSync(tmpBox);  } catch {}
    try { unlinkSync(tmpName); } catch {}
    try { unlinkSync(tmpMeta); } catch {}
  }
}

export function parseAttributes(ocrText, configuredAttrs = null) {
  const attrs = {};
  const lines  = ocrText.split('\n').map(l => l.trim()).filter(Boolean);

  const targetNames = (configuredAttrs
    ? configuredAttrs.map(a => ABBREV_TO_OCR[a]).filter(Boolean)
    : ALL_NAMES).sort((a, b) => b.length - a.length);

  console.log('configuredAttrs:', configuredAttrs);
  console.log('targetNames:', targetNames);

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim();
    const line = raw
      .replace(/THROWPOWER/g, 'THROW POWER')
      .replace(/SHORTACCURACY/g, 'SHORT ACCURACY')
      .replace(/MIDACCURACY/g, 'MID ACCURACY')
      .replace(/MEDIUMACCURACY/g, 'MEDIUM ACCURACY')
      .replace(/DEEPACCURACY/g, 'DEEP ACCURACY')
      .replace(/THROW\s?ON\s?RUN/g, 'THROW ON RUN')
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
      return name === 'TACKLE'
        ? line.includes('BREAK TACKLE') ? false : line.includes('TACKLE')
        : new RegExp('\\b' + escaped + '\\b').test(line);
    });
    if (foundNames.length === 0) continue;
    console.log('foundNames:', foundNames, '| nextLine:', (lines[i+1]||'').trim());

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
      .replace(/\bBOR\b/gi, '70')
      .replace(/\bSerle\b/gi, '70')
      .replace(/\b[Ll]h\b/gi, '74')
      .replace(/\b\[are\b/gi, '79')
      .replace(/^[A-Za-z]+(\d{2,3})\b/, '$1')   // leading letters: ED79->79
      .replace(/\b921\b/g, '91')                  // known misread: 921->91
      .replace(/\b929\b/g, '99')                  // known misread: 929->99
      .replace(/\b924\b/g, '94')                  // known misread: 924->94
      .replace(/\b(\d)\d(\d)\b/g, (m, a, b) => {  // 3-digit where first+last make sense: 929->99, 818->81
        const twoDigit = parseInt(a + b);
        return (twoDigit >= 40 && twoDigit <= 99) ? String(twoDigit) : m;
      })
      .replace(/(\d{2})[°.:]+/g, '$1');           // trailing punctuation on numbers
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
