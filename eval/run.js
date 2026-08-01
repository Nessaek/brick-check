#!/usr/bin/env node
// Eval harness: runs every case in eval/cases/ through the live /api/analyze
// endpoint and scores the results against each case's expected.json.
//
// Usage:
//   npm start          (in another terminal — the server must be running)
//   npm run eval
//
// A case is a directory containing:
//   build.<jpg|png|webp>       — photo of the (possibly wrong) build
//   reference.<jpg|png|webp>   — optional reference photo
//   expected.json              — ground truth:
//     {
//       "description": "what this case tests",
//       "tolerance": 25,        // optional per-case override of EVAL_TOLERANCE
//       "defects": [
//         { "x": 82, "y": 78, "label": "missing brick on tram panel",
//           "types": ["MISSING PIECE", "WRONG PIECE"],    // types optional
//           "alt": [[40, 45]] }  // optional alternate acceptable locations
//       ]
//     }
//   A clean build (nothing wrong) is simply "defects": [].
//
// Scoring: a defect counts as CAUGHT if a reported issue lies within
// TOLERANCE percentage points (Euclidean) of its x/y. Reported issues that
// match no expected defect count as false positives. A case passes when
// every defect is caught and there are no false positives.

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.EVAL_URL || 'http://localhost:3000';
const TOLERANCE = Number(process.env.EVAL_TOLERANCE || 12);
const CASES_DIR = path.join(__dirname, 'cases');
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function findImage(dir, stem) {
  const file = fs.readdirSync(dir).find(f => {
    const ext = path.extname(f).toLowerCase();
    return path.basename(f, ext) === stem && MIME_BY_EXT[ext];
  });
  return file ? path.join(dir, file) : null;
}

function toDataUrl(filePath) {
  const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

async function analyse(body, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const response = await fetch(`${BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (response.status === 429 && attempt < 3) {
      process.stdout.write('    (rate limited — waiting 61s)\n');
      await new Promise(resolve => setTimeout(resolve, 61_000));
      return analyse(body, attempt + 1);
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function score(expectedDefects, issues, tolerance) {
  let remaining = [...issues];
  const results = [];
  for (const defect of expectedDefects) {
    const spots = [[defect.x, defect.y], ...(defect.alt || [])];
    const distTo = issue => Math.min(...spots.map(([sx, sy]) => Math.hypot(issue.x - sx, issue.y - sy)));
    // All reported issues within tolerance belong to this defect — models
    // often describe one physical change as several facets (a removed plate,
    // the piece it exposed, the part it unseated). The closest one is the
    // primary match; the rest are absorbed rather than counted as false
    // positives.
    const matched = remaining.filter(issue => distTo(issue) <= tolerance);
    remaining = remaining.filter(issue => distTo(issue) > tolerance);
    if (matched.length) {
      matched.sort((a, b) => distTo(a) - distTo(b));
      const issue = matched[0];
      const typeOk = !defect.types || matched.some(m => !defect.types || defect.types.includes(m.type));
      results.push({ defect, caught: true, issue, dist: Math.round(distTo(issue)), typeOk, absorbed: matched.length - 1 });
    } else {
      results.push({ defect, caught: false });
    }
  }
  return { results, falsePositives: remaining };
}

async function main() {
  if (!fs.existsSync(CASES_DIR)) {
    console.error(`No cases directory at ${CASES_DIR}`);
    process.exit(1);
  }
  const caseNames = fs.readdirSync(CASES_DIR)
    .filter(name => fs.existsSync(path.join(CASES_DIR, name, 'expected.json')))
    .sort();
  if (!caseNames.length) {
    console.error('No cases found. Add eval/cases/<name>/{build.jpg, reference.jpg, expected.json}.');
    process.exit(1);
  }

  console.log(`Running ${caseNames.length} case(s) against ${BASE_URL} (tolerance ±${TOLERANCE}%)\n`);
  let totalDefects = 0, totalCaught = 0, totalFalsePositives = 0, failedCases = [];

  for (const name of caseNames) {
    const dir = path.join(CASES_DIR, name);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const buildPath = findImage(dir, 'build');
    if (!buildPath) { console.log(`✗ ${name}: no build image — skipped`); failedCases.push(name); continue; }
    const refPath = findImage(dir, 'reference');

    const started = Date.now();
    let data;
    try {
      data = await analyse({ image: toDataUrl(buildPath), referenceImage: refPath ? toDataUrl(refPath) : '' });
    } catch (error) {
      console.log(`✗ ${name}: request failed — ${error.message}`);
      console.log('  Is the server running? Start it with: npm start');
      failedCases.push(name);
      continue;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const defects = expected.defects || [];
    const tolerance = Number(expected.tolerance || TOLERANCE);
    const { results, falsePositives } = score(defects, data.issues || [], tolerance);
    const caught = results.filter(r => r.caught).length;
    totalDefects += defects.length;
    totalCaught += caught;
    totalFalsePositives += falsePositives.length;

    const pass = caught === defects.length && falsePositives.length === 0;
    if (!pass) failedCases.push(name);
    console.log(`${pass ? '✓' : '✗'} ${name}  (${seconds}s, aligned: ${data.aligned ? 'yes' : 'no'})`);
    if (expected.description) console.log(`    ${expected.description}`);
    for (const r of results) {
      if (r.caught) {
        const typeNote = r.typeOk ? '' : ` [type ${r.issue.type}, expected ${r.defect.types.join('/')}]`;
        const absorbedNote = r.absorbed ? ` (+${r.absorbed} related report${r.absorbed === 1 ? '' : 's'})` : '';
        console.log(`    CAUGHT  ${r.defect.label || `defect @ ${r.defect.x},${r.defect.y}`} — reported @ ${r.issue.x},${r.issue.y} (off by ${r.dist})${typeNote}${absorbedNote}`);
      } else {
        console.log(`    MISSED  ${r.defect.label || `defect @ ${r.defect.x},${r.defect.y}`}`);
      }
    }
    for (const fp of falsePositives) {
      console.log(`    FALSE+  ${fp.type} @ ${fp.x},${fp.y} — ${fp.title}`);
    }
    if (!defects.length && !falsePositives.length) console.log('    CLEAN   correctly reported no issues');
  }

  console.log('\n——— Scorecard ———');
  console.log(`Cases passed:     ${caseNames.length - failedCases.length}/${caseNames.length}${failedCases.length ? `  (failed: ${failedCases.join(', ')})` : ''}`);
  console.log(`Defects caught:   ${totalCaught}/${totalDefects}`);
  console.log(`False positives:  ${totalFalsePositives}`);
  process.exit(failedCases.length ? 1 : 0);
}

main();
