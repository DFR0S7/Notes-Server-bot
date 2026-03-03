import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Maps full OCR names → standardized attribute keys
const NAME_MAP = {
  'AWARENESS':          'Awareness',
  'SPEED':              'Speed',
  'ACCELERATION':       'Acceleration',
  'AGILITY':            'Agility',
  'STRENGTH':           'Strength',
  'JUMP':               'Jump',
  'STAMINA':            'Stamina',
  'INJURY':             'Injury',
  'THROW POWER':        'Throw Power',
  'SHORT ACCURACY':     'Short Acc',
  'MID ACCURACY':       'Mid Acc',
  'DEEP ACCURACY':      'Deep Acc',
  'THROW ON RUN':       'Throw On Run',
  'PLAY ACTION':        'Play Action',
  'BREAK SACK':         'Break Sack',
  'CARRYING':           'Carrying',
  'CATCHING':           'Catching',
  'CATCH IN TRAFFIC':   'Catch In Traffic',
  'SPECTACULAR CATCH':  'Spec Catch',
  'ROUTE RUNNING':      'Route Running',
  'SHORT ROUTE':        'Short Route',
  'MED ROUTE':          'Med Route',
  'DEEP ROUTE':         'Deep Route',
  'RELEASE':            'Release',
  'BREAK TACKLE':       'Break Tackle',
  'TRUCKING':           'Trucking',
  'ELUSIVENESS':        'Elusiveness',
  'BC VISION':          'BC Vision',
  'SPIN MOVE':          'Spin Move',
  'JUKE MOVE':          'Juke Move',
  'CHANGE OF DIRECTION':'Change of Direction',
  'STIFF ARM':          'Stiff Arm',
  'TACKLE':             'Tackle',
  'HIT POWER':          'Hit Power',
  'PURSUIT':            'Pursuit',
  'PLAY RECOGNITION':   'Play Recognition',
  'MAN COVERAGE':       'Man Coverage',
  'ZONE COVERAGE':      'Zone Coverage',
  'PRESS':              'Press',
  'POWER MOVES':        'Power Moves',
  'FINESSE MOVES':      'Finesse Moves',
  'BLOCK SHEDDING':     'Block Shedding',
  'PASS BLOCK':         'Pass Block',
  'RUN BLOCK':          'Run Block',
  'PASS BLOCK POWER':   'Pass Block Power',
  'PASS BLOCK FINESSE': 'Pass Block Finesse',
  'RUN BLOCK POWER':    'Run Block Power',
  'RUN BLOCK FINESSE':  'Run Block Finesse',
  'LEAD BLOCK':         'Lead Block',
  'IMPACT BLOCKING':    'Impact Blocking',
  'KICK POWER':         'Kick Power',
  'KICK ACCURACY':      'Kick Accuracy',
  'KICK RETURN':        'Kick Return',
};

export async function performOCR(imageUrl) {
  const tmpPath = join(tmpdir(), 'recruit_' + Date.now() + '.png');
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpPath, Buffer.from(response.data));

  const worker = await createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(tmpPath);
    console.log('OCR raw output:\n', text); // helpful for debugging
    return text;
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpPath); } catch {}
  }
}

export function parseAttributes(ocrText) {
  const attrs = {};
  const lines = ocrText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const nameLine  = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim();
    const valueLine = lines[i + 1].trim();

    // Value line should be a 2-digit number (1-99)
    const valueMatch = valueLine.match(/^(\d{2,3})$/);
    if (!valueMatch) continue;

    const value = parseInt(valueMatch[1]);
    if (value < 1 || value > 99) continue;

    // Look up the name in our map
    const key = NAME_MAP[nameLine];
    if (!key) continue;

    attrs[key] = value;
    i++; // skip the value line so we don't re-process it
  }

  return attrs;
}
