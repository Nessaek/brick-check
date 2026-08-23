// Saving a submission someone reported as wrong.
//
// This is the only part of BrickSolver that keeps a user's photos. Everything
// else deletes them in a finally block, and the UI says so, which is why this
// runs ONLY when someone presses "this wasn't right" — never on a normal
// analysis. A wrong answer is the thing worth keeping; the successes are
// noise, and storing them would mean holding far more personal data for no
// gain.
//
// S3 rather than the instance disk: the instance is cattle. Editing user-data
// replaces it, which has happened repeatedly, and anything written to its
// filesystem goes with it.
//
// Signed by hand because the app has no npm dependencies and the container has
// no AWS CLI. SigV4 is a well-specified 40 lines; a dependency tree is not.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REGION = process.env.AWS_REGION || 'eu-west-2';
const BUCKET = process.env.FEEDBACK_BUCKET || '';
const DIR = process.env.FEEDBACK_DIR || '';

const enabled = () => Boolean(BUCKET || DIR);
const describe = () => (BUCKET ? `S3 bucket ${BUCKET}` : DIR ? `local directory ${DIR}` : '');

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

let cachedCredentials = null;

// The instance role, read from IMDSv2. Note this needs the instance's metadata
// hop limit to be 2: the request comes from inside a container, which costs a
// hop, and the AWS default of 1 silently drops it.
async function instanceCredentials() {
  if (cachedCredentials && cachedCredentials.expires > Date.now() + 60_000) return cachedCredentials;

  const token = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' },
    signal: AbortSignal.timeout(3000)
  }).then(r => r.text());

  const base = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
  const headers = { 'x-aws-ec2-metadata-token': token };
  const role = (await fetch(base, { headers, signal: AbortSignal.timeout(3000) }).then(r => r.text())).trim();
  const body = await fetch(base + role, { headers, signal: AbortSignal.timeout(3000) }).then(r => r.json());

  cachedCredentials = {
    key: body.AccessKeyId,
    secret: body.SecretAccessKey,
    session: body.Token,
    expires: new Date(body.Expiration).getTime()
  };
  return cachedCredentials;
}

async function putToS3(key, body, contentType) {
  const creds = await instanceCredentials();
  const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const hash = sha256(body);

  const headers = {
    host,
    'x-amz-content-sha256': hash,
    'x-amz-date': stamp,
    ...(creds.session ? { 'x-amz-security-token': creds.session } : {})
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    'PUT',
    '/' + key.split('/').map(encodeURIComponent).join('/'),
    '',
    names.map(n => `${n}:${headers[n]}`).join('\n') + '\n',
    names.join(';'),
    hash
  ].join('\n');

  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(Buffer.from(canonical))].join('\n');
  let signing = hmac(`AWS4${creds.secret}`, day);
  for (const part of [REGION, 's3', 'aws4_request']) signing = hmac(signing, part);
  const signature = crypto.createHmac('sha256', signing).update(toSign).digest('hex');

  const response = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': contentType,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
    },
    body,
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`S3 rejected ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

async function putLocal(key, body) {
  const target = path.join(DIR, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

// Files are written before the metadata, so a half-finished submission is
// visible as one missing meta.json rather than a metadata record pointing at
// images that never arrived.
async function saveFeedback({ build, reference, meta }) {
  if (!enabled()) throw new Error('Feedback collection is not configured on this server.');

  const id = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const put = BUCKET ? putToS3 : (key, body) => putLocal(key, body);

  await put(`${id}/build.jpg`, build.buffer, build.mimeType);
  if (reference) await put(`${id}/reference.jpg`, reference.buffer, reference.mimeType);
  await put(`${id}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2)), 'application/json');
  return id;
}

module.exports = { saveFeedback, feedbackEnabled: enabled, feedbackTarget: describe };
