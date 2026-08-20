#!/usr/bin/env node
// Turns a reported mistake into an eval case.
//
// This is the step that makes feedback worth collecting. A saved submission is
// just two photos and a complaint; an eval case is a labelled regression test
// the harness scores every run. The gap between them is the ground truth, and
// only a person looking at the photos can supply that — hence the placeholder
// expected.json this writes, which you fill in by hand.
//
// Usage:
//   node eval/promote-feedback.js <dir-or-s3-prefix> <case-name>
//
// For S3, sync it down first — the instance can write to the bucket but not
// read it, deliberately, so pulling is a job for your own credentials:
//   aws s3 sync s3://<bucket>/<id>/ /tmp/<id>/ --region eu-west-2
const fs = require('fs');
const path = require('path');

const [source, name] = process.argv.slice(2);
if (!source || !name) {
  console.error('Usage: node eval/promote-feedback.js <downloaded-submission-dir> <case-name>');
  process.exit(1);
}

const target = path.join(__dirname, 'cases', name);
if (fs.existsSync(target)) {
  console.error(`Case "${name}" already exists at ${target} — pick another name.`);
  process.exit(1);
}

const build = path.join(source, 'build.jpg');
const reference = path.join(source, 'reference.jpg');
if (!fs.existsSync(build)) {
  console.error(`No build.jpg in ${source}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(build, path.join(target, 'build.jpg'));
if (fs.existsSync(reference)) fs.copyFileSync(reference, path.join(target, 'reference.jpg'));

let meta = {};
try { meta = JSON.parse(fs.readFileSync(path.join(source, 'meta.json'), 'utf8')); } catch { /* optional */ }

const reported = meta.reported?.issues || [];
const expected = {
  description: meta.note
    ? `Reported by a user: ${meta.note}`
    : 'Reported as wrong by a user. Describe the real defect here.',
  // Left empty on purpose. The reported issues below are what the app got
  // WRONG, so copying them in would enshrine the bug as the expected answer.
  defects: [],
  tolerance: 25,
  _reportedAt: meta.reportedAt || null,
  _whatTheAppSaid: reported.map(i => ({ type: i.type, title: i.title, x: i.x, y: i.y })),
  _todo: 'Fill in defects[] with the REAL defect locations as x/y percentages of build.jpg, then delete the _ fields.'
};
fs.writeFileSync(path.join(target, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');

console.log(`Created eval/cases/${name}/`);
console.log(`  build.jpg${fs.existsSync(reference) ? ' + reference.jpg' : '  (no reference!)'}`);
if (meta.note) console.log(`  user said: ${meta.note}`);
if (reported.length) {
  console.log('  the app reported:');
  for (const i of reported) console.log(`    [${i.x},${i.y}] ${i.type}: ${i.title}`);
}
console.log('\nNow edit expected.json: put the REAL defect coordinates in defects[], then run:');
console.log(`  npm run eval -- ${name}`);
