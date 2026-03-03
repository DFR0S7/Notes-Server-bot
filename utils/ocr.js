import { createWorker } from 'tesseract.js';
import axios from 'axios';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Known CFB26 attribute names as they appear in OCR (uppercase)
const NAME_MAP = {
  'AWARENESS':            'Awareness',
  'SPEED':                'Speed',
  'ACCELERATION':         'Acceleration',
  'AGILITY':              'Agility',
  'STRENGTH':             'Strength',
  'JUMP':                 'Jump',
  'STAMINA':              'Stamina',
  'INJURY':               'Injury',
  'THROW POWER':          'Throw Power',
  'SHORT ACCURACY':       'Short Acc',
  'MID ACCURACY':         'Mid Acc',
  'DEEP ACCURACY':        'Deep Acc',
  'THROW ON RUN':         'Throw On Run',
  'PLAY ACTION':          'Play Action',
  'BREAK SACK':           'Break Sack',
  'CARRYING':             'Carrying',
  'CATCHING':             'Catching',
  'CATCH IN TRAFFIC':     'Catch In Traffic',
  'SPECTACULAR CATCH':    'Spec Catch',
  'ROUTE RUNNING':        'Route Running',
  'SHORT ROUTE':          'Short Route',
  'MED ROUTE':            'Med Route',
  'DEEP ROUTE':           'Deep Route',
  'RELEASE':              'Release',
  'BREAK TACKLE':         'Break Tackle',
  'TRUCKING':             'Trucking',
  'ELUSIVENESS':          'Elusiveness',
  'BC VISION':            'BC Vision',
  'SPIN MOVE':            'Spin Move',
  'JUKE MOVE':            'Juke Move',
  'CHANGE OF DIRECTION':  'Change of Direction',
  'STIFF ARM':            'Stiff Arm',
  'TACKLE':               'Tackle',
  'HIT POWER':            'Hit Power',
  'PURSUIT':              'Pursuit',
  'PLAY RECOGNITION':     'Play Recognition',
  'MAN COVERAGE':         'Man Coverage',
  'ZONE COVERAGE':        'Zone Coverage',
  'PRESS':                'Press',
  'POWER MOVES':          'Power Moves',
  'FINESSE MOVES':        'Finesse Moves',
  'BLOCK SHEDDING':       'Block Shedding',
  'PASS BLOCK':           'Pass Block',
  'RUN BLOCK':            'Run Block',
  'PASS BLOCK POWER':     'Pass Block Power',
  'PASS BLOCK FINESSE':   'Pass Block Finesse',
  'RUN BLOCK POWER':      'Run Block Power',
  'RUN BLOCK FINESSE':    'Run Block Finesse',
  'LEAD BLOCK':           'Lead Block',
  'IMPACT BLOCKING':      'Impact Blocking',
  'KICK POWER':           'Kick Power',
  'KICK ACCURACY':        'Kick Accuracy',
  'KICK RETURN':          'Kick Return',
};

// All known attribute name tokens for matching partial lines
const ALL_NAMES = Object.keys(NAME_MAP);

export async function performOCR(imageUrl) {
  const tmpPath = join(tmpdir(), 'recruit_' + Date.now() + '.png');
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  writeFileSync(tmpPath, Buffer.from(response.data));

  const worker = await createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(tmpPath);
    console.log('OCR raw output:\n', text);
    return text;
  } finally {
    await worker.terminate();
    try { unlinkSync(tmpPath); } catch {}
  }
}

export function parseAttributes(ocrText) {
  const attrs = {};

  // Extract all attribute names found anywhere in the text
  const upperText = ocrText.toUpperCase();

  // Find all numbers (2-digit) in the text with context
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);

  // Strategy: find lines that contain known attribute names,
  // then find the next line that contains numbers for those names
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toUpperCase().replace(/[^A-Z\s]/g, '').trim();

    // Check if this line contains one or two known attribute names
    const foundNames = ALL_NAMES.filter(name => line.includes(name));
    if (foundNames.length === 0) continue;

    // Look at next line for numbers
    const nextLine = (lines[i + 1] || '').trim();
    const numbers  = nextLine.match(/\b\d{2,3}\b/g);
    if (!numbers) continue;

    // Match names to numbers positionally
    // Sort by position in the line to preserve left-right order
    const sortedNames = foundNames
      .map(name => ({ name, pos: line.indexOf(name) }))
      .sort((a, b) => a.pos - b.pos);

    sortedNames.forEach((entry, idx) => {
      if (numbers[idx] !== undefined) {
        const value = parseInt(numbers[idx]);
        if (value >= 1 && value <= 99) {
          const key = NAME_MAP[entry.name];
          if (key) attrs[key] = value;
        }
      }
    });

    i++; // skip the numbers line
  }

  console.log('Parsed attributes:', attrs);
  return attrs;
}
