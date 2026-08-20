const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { saveFeedback, feedbackEnabled, feedbackTarget } = require('./feedback');
const { execFile } = require('child_process');

const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg' };
const STATIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/example-reference.jpg']);

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

// Claude model used for build analysis. Sonnet is a strong, cost-effective
// choice for vision comparison tasks like this one. Override with
// CLAUDE_MODEL in .env (e.g. claude-opus-5 for tougher comparisons,
// claude-haiku-4-5-20251001 for faster/cheaper checks).
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// Image formats the Anthropic API accepts. Anything else (notably HEIC from
// iPhones when the browser couldn't convert it) gets a clear error up front
// instead of an opaque API failure.
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Simple per-IP rate limit on /api/analyze — each request costs real money
// (a Claude vision call), so cap bursts even for personal use.
const RATE_LIMIT = { windowMs: 60_000, max: 8 };
const requestLog = new Map();

// Behind a load balancer every request arrives from the proxy's address, so
// keying the rate limit on the socket address would put all visitors in one
// bucket. X-Forwarded-For is trivially spoofable, though, so only trust it
// when TRUST_PROXY says something upstream is setting it.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

// Optional shared-password gate (HTTP Basic). Unset APP_PASSWORD — the
// default, and how local development runs — leaves the app wide open, which
// is fine on localhost but must not be how it is exposed to the internet:
// every analysis spends real money on the Anthropic API.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const supplied = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(APP_PASSWORD);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function rateLimited(ip) {
  const now = Date.now();
  // Every distinct address adds an entry, so on a public deployment the map
  // would grow forever. Sweep expired entries once it gets large.
  if (requestLog.size > 500) {
    for (const [key, times] of requestLog) {
      if (times.every(time => now - time >= RATE_LIMIT.windowMs)) requestLog.delete(key);
    }
  }
  const recent = (requestLog.get(ip) || []).filter(time => now - time < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) { requestLog.set(ip, recent); return true; }
  recent.push(now);
  requestLog.set(ip, recent);
  return false;
}

// Photos of the same build shot at different angles/lighting are hard to
// compare fairly — a "wrong color" can just be warm gallery light. When a
// reference photo is supplied, we try to align + color-normalize it onto
// the build photo's perspective before sending both to Claude. This is
// optional: if python3/opencv/scikit-image aren't available, we skip it
// silently and fall back to the original photos.
const ALIGN_SCRIPT = path.join(root, 'preprocess', 'align.py');
const GRID_SCRIPT = path.join(root, 'preprocess', 'grid.py');
const CROP_SCRIPT = path.join(root, 'preprocess', 'crop.py');
const ALIGN_TIMEOUT_MS = 15_000;
// Prefer the project-local venv (see README) so opencv/scikit-image don't
// need to be installed into the system Python.
const VENV_PYTHON = path.join(root, 'preprocess', '.venv', 'bin', 'python3');
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
};
let alignmentAvailable = false;

function send(res, code, body, contentType = 'application/json') {
  // An oversized or aborted request destroys the socket, so a reply may no
  // longer be deliverable — writing anyway throws inside the request handler.
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

const MAX_BODY_BYTES = 15_000_000;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        // Rejecting alone leaves the client streaming into memory we keep
        // appending to. Drop what we have and stop reading; pausing rather
        // than destroying keeps the socket alive long enough to send a real
        // status back instead of resetting the connection mid-upload.
        rejected = true;
        body = '';
        req.pause();
        const error = new Error('That photo is too large — please use one under 15 MB.');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid request body.')); }
    });
    req.on('error', error => { if (!rejected) reject(error); });
  });
}
function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image format. Expected a base64 data URL.');
  if (!match[1].startsWith('image/')) throw new Error('Only image files are supported.');
  return { mimeType: match[1], data: match[2] };
}

function checkAlignmentAvailable() {
  return new Promise(resolve => {
    execFile(PYTHON, ['-c', 'import cv2, numpy'], error => resolve(!error));
  });
}

// Runs preprocess/align.py to warp+color-normalize `referenceImage` onto
// `mainImage`'s perspective. Never throws — always resolves to a result
// object, so callers can safely fall back to the original images.
function alignReferenceToBuild(mainImage, referenceImage) {
  return new Promise(resolve => {
    if (!alignmentAvailable) return resolve({ success: false, reason: 'unavailable' });

    let tmpDir;
    try {
      const main = parseDataUrl(mainImage);
      const ref = parseDataUrl(referenceImage);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickcheck-'));
      const mainPath = path.join(tmpDir, `target${EXT_BY_MIME[main.mimeType] || '.img'}`);
      const refPath = path.join(tmpDir, `reference${EXT_BY_MIME[ref.mimeType] || '.img'}`);
      fs.writeFileSync(mainPath, Buffer.from(main.data, 'base64'));
      fs.writeFileSync(refPath, Buffer.from(ref.data, 'base64'));

      execFile(PYTHON, [ALIGN_SCRIPT, mainPath, refPath], { timeout: ALIGN_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 }, (error, stdout) => {
        fs.rm(tmpDir, { recursive: true, force: true }, () => {});
        if (error) return resolve({ success: false, reason: error.message });
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ success: false, reason: 'Could not parse alignment output.' }); }
      });
    } catch (error) {
      if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      resolve({ success: false, reason: error.message });
    }
  });
}

const ISSUE_TYPES = new Set(['MISSING PIECE', 'WRONG ORIENTATION', 'WRONG PIECE', 'MISPLACED PIECE']);
const ISSUE_COLORS = new Set(['blue', 'red', 'grey', 'yellow', 'green', 'black', 'white']);

// Overlays a labeled coordinate grid on the build photo (preprocess/grid.py)
// so Claude can read pin positions off the grid instead of estimating them.
// Resolves to {mimeType, data} or null — callers fall back to the clean photo.
function overlayGrid(image) {
  return new Promise(resolve => {
    if (!alignmentAvailable) return resolve(null);
    let tmpDir;
    try {
      const parsed = parseDataUrl(image);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickcheck-grid-'));
      const imgPath = path.join(tmpDir, `img${EXT_BY_MIME[parsed.mimeType] || '.img'}`);
      fs.writeFileSync(imgPath, Buffer.from(parsed.data, 'base64'));
      execFile(PYTHON, [GRID_SCRIPT, imgPath], { timeout: ALIGN_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 }, (error, stdout) => {
        fs.rm(tmpDir, { recursive: true, force: true }, () => {});
        if (error) return resolve(null);
        try {
          const result = JSON.parse(stdout);
          resolve(result.success ? { mimeType: result.mime, data: result.image_base64 } : null);
        } catch { resolve(null); }
      });
    } catch {
      if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      resolve(null);
    }
  });
}

function normalizeIssues(issues) {
  if (!Array.isArray(issues)) return [];
  // The tool schema constrains type/color, but the client renders them into
  // class names unescaped — clamp to the known enums rather than trust them.
  return issues.slice(0, 8).map((issue, index) => ({
    number: index + 1,
    type: ISSUE_TYPES.has(issue.type) ? issue.type : 'MISPLACED PIECE',
    title: issue.title || 'Review this area',
    detail: issue.detail || '',
    action: issue.action || 'Fix this',
    color: ISSUE_COLORS.has(issue.color) ? issue.color : 'grey',
    x: Math.min(92, Math.max(8, Number(issue.x) || 20 + index * 15)),
    y: Math.min(88, Math.max(12, Number(issue.y) || 28 + index * 12))
  }));
}

// Tool definition that forces Claude to return a well-shaped, structured
// result instead of freeform prose. This is the Claude equivalent of
// Gemini's `responseSchema` / `responseMimeType: application/json`.
const REPORT_ISSUES_TOOL = {
  name: 'report_build_issues',
  description: 'Report the list of visible mistakes found in a LEGO build photo.',
  input_schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['MISSING PIECE', 'WRONG ORIENTATION', 'WRONG PIECE', 'MISPLACED PIECE']
            },
            title: { type: 'string', description: 'Short imperative fix, e.g. "Add a 2x2 blue plate"' },
            detail: { type: 'string', description: 'One specific sentence about what to change and where, using the real colors/shapes/locations visible in the photo.' },
            action: { type: 'string', description: 'Short button label, e.g. "Place here"' },
            color: {
              type: 'string',
              enum: ['blue', 'red', 'grey', 'yellow', 'green', 'black', 'white']
            },
            x: { type: 'integer', description: 'Percent (0-100) across image 1 (the user\'s build) where the issue appears' },
            y: { type: 'integer', description: 'Percent (0-100) down image 1 (the user\'s build) where the issue appears' }
          },
          required: ['type', 'title', 'detail', 'action', 'color', 'x', 'y']
        }
      }
    },
    required: ['issues']
  }
};

// A methodical sweep instruction markedly improves recall — without it the
// model tends to fixate on the center of the build and miss issues near the
// edges and corners.
const SCAN_INSTRUCTION = 'Work methodically: mentally divide image 1 into a 3x3 grid and inspect every cell one by one — top-left, top-center, top-right, middle-left, center, middle-right, bottom-left, bottom-center, bottom-right. Pay just as much attention to the edges and corners as to the center. First write out your region-by-region inspection notes, then call the report_build_issues tool with every issue you found (up to 8). For each issue, x and y are percentages of the FULL photo: x=0 is the left edge, x=100 the right edge, y=0 the top edge, y=100 the bottom edge (so the photo center is x=50, y=50). Place each pin at the exact center of the problem area, and double-check the pin lands on the defect before reporting.';

// Photos of 3D builds are rarely shot from identical viewpoints — without
// this guard the model reports parts hidden by the camera angle as missing.
const VIEWPOINT_GUARD = 'Important: the two photos may be taken from different angles, distances, or sides, so some parts may be hidden or newly visible purely because of the viewpoint — that is NOT a defect. Report only differences in the physical build itself, and if you cannot tell whether a difference is physical or just perspective/lighting, do not report it. Worked example of this reasoning: the reference shows a model from the front, with two side arms and a printed face visible; the build photo is a close-up from behind, where the face is on the far side and the arms are at the edge of the frame or cut off. Wrong: "add missing arms", "add missing face" — those parts are simply not in view. Right: first ask "would this part even be visible from this camera position?" — only if the answer is yes and the part is still absent is it a real issue.';

// Reading an instruction page is a different and far more reliable operation
// than recognising a set from a photo of the finished model. Measured on this
// repo's own photos, identification-from-photo returned "unknown" three times
// out of three on one image and two DIFFERENT wrong set numbers on another,
// both at medium confidence — and one of those wrong numbers is a real set,
// so a catalogue existence check would have waved it through. A printed set
// number on a booklet cover is text to be read, not trivia to be recalled,
// so the prompt below pushes hard toward reading and toward "unknown".
const INSTRUCTION_TOOL = {
  name: 'read_instruction_page',
  description: 'Report what is printed on a LEGO instruction booklet page.',
  input_schema: {
    type: 'object',
    properties: {
      setNumber: {
        type: 'string',
        description: 'The official set number printed on the page, digits only (e.g. "10349"). Use "unknown" unless you can literally SEE it printed.'
      },
      setName: { type: 'string', description: 'Set name if printed, else "unknown".' },
      stepNumber: { type: 'string', description: 'The build step number shown, else "unknown".' },
      // Flat strings, not objects. With {description, quantity} items the model
      // returned the WHOLE payload JSON-encoded into this one property on 2 of
      // 3 trials, burying setNumber where nothing could read it. A nested
      // array-of-objects beside plain scalars was apparently enough to tip it.
      partsCallout: {
        type: 'array',
        maxItems: 12,
        description: 'The parts box printed on the page, one entry per row, e.g. "2x blue 2x4 plate".',
        items: { type: 'string' }
      },
      readable: { type: 'boolean', description: 'False if this does not look like an instruction page at all.' }
    },
    required: ['setNumber', 'readable']
  }
};

const INSTRUCTION_PROMPT = 'This image should be a page from a LEGO instruction booklet. Report only what is PRINTED on the page — read it, do not infer it from the model shown. The set number is usually on the cover or in a corner, often near the LEGO logo. If you cannot literally see a set number printed in the image, return "unknown"; do not deduce it from recognising the model, because that guess is wrong more often than it is right. Do the same for the step number and set name. If a parts callout box is printed on the page, list its contents. If this is not an instruction page at all, set readable to false.';

// Models occasionally answer a tool call by JSON-encoding the entire intended
// payload into a single string property instead of filling the fields. Seen on
// 2 of 3 trials against an earlier version of this schema, and the failure is
// silent: the call succeeds, the fields read as absent, and the feature just
// appears not to work. Simplifying the schema made it rare; this makes it
// harmless.
function unwrapToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const value of Object.values(input)) {
      if (typeof value !== 'string' || !value.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...input, ...parsed };
      } catch { /* not JSON — the property is just a string */ }
    }
  }
  return input;
}

// Only runs when the user explicitly chose "upload instruction page", so the
// extra call is opt-in and the default flow costs exactly what it did before.
async function readInstructionPage(referenceImage) {
  try {
    const parsed = parseDataUrl(referenceImage);
    if (!parsed) return null;
    const toolUse = await callClaude([
      { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.data } },
      { type: 'text', text: INSTRUCTION_PROMPT }
    ], false, INSTRUCTION_TOOL);
    if (!toolUse?.input) return null;
    const input = unwrapToolInput(toolUse.input);
    if (input.readable === false) return null;

    const clean = value => {
      const text = String(value ?? '').trim();
      return !text || /^unknown$/i.test(text) ? null : text;
    };
    const setNumber = clean(input.setNumber);
    return {
      // Set numbers are digits, sometimes with a -1 variant suffix. Anything
      // else is the model narrating rather than reading.
      setNumber: setNumber && /^\d{3,7}(-\d+)?$/.test(setNumber) ? setNumber.split('-')[0] : null,
      setName: clean(input.setName),
      stepNumber: clean(input.stepNumber),
      partsCallout: Array.isArray(input.partsCallout)
        ? input.partsCallout.map(p => (typeof p === 'string' ? p : p?.description)).filter(Boolean).slice(0, 12)
        : []
    };
  } catch {
    // An unreadable instruction page must never fail the analysis — the whole
    // feature is an optional enhancement on top of the normal comparison.
    return null;
  }
}

const VERIFY_TOOL = {
  name: 'verify_build_issues',
  description: 'Return a verdict for each candidate issue after inspecting the zoomed crops.',
  input_schema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer', description: 'The candidate number being judged' },
            verdict: { type: 'string', enum: ['confirm', 'reject'] },
            reason: { type: 'string', description: 'One short sentence explaining the verdict' },
            x: { type: 'integer', description: 'Refined x percent on the FULL build photo, only if the pin should move' },
            y: { type: 'integer', description: 'Refined y percent on the FULL build photo, only if the pin should move' }
          },
          required: ['number', 'verdict']
        }
      }
    },
    required: ['decisions']
  }
};

// Cuts a zoomed crop around (x, y) via preprocess/crop.py. Resolves to
// {data, box} or null — verification silently skips crops it can't make.
function cropAt(imagePath, x, y, mark) {
  return new Promise(resolve => {
    const args = [CROP_SCRIPT, imagePath, String(x), String(y)];
    if (mark) args.push('--mark');
    execFile(PYTHON, args, { timeout: ALIGN_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const result = JSON.parse(stdout);
        resolve(result.success ? { data: result.image_base64, box: result.box } : null);
      } catch { resolve(null); }
    });
  });
}

// Second-pass verification: re-examine each first-pass issue on a zoomed
// crop before showing it to the user. A crop concentrates the model's whole
// visual budget on the spot in question, and judging one specific claim
// against focused evidence is far more reliable than the open-ended search
// of the first pass. Never throws — on any failure the first-pass issues
// are returned unverified.
async function verifyIssues(issues, image, referenceToSend, aligned) {
  if (!issues.length || !alignmentAvailable) return { issues, verified: false, rejected: [] };

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickcheck-verify-'));
    const main = parseDataUrl(image);
    const buildPath = path.join(tmpDir, `build${EXT_BY_MIME[main.mimeType] || '.img'}`);
    fs.writeFileSync(buildPath, Buffer.from(main.data, 'base64'));
    let refPath = null;
    let refImage = null;
    if (referenceToSend) {
      refImage = parseDataUrl(referenceToSend);
      refPath = path.join(tmpDir, `ref${EXT_BY_MIME[refImage.mimeType] || '.img'}`);
      fs.writeFileSync(refPath, Buffer.from(refImage.data, 'base64'));
    }

    const content = [{
      type: 'text',
      text: 'You previously analysed a LEGO build photo and reported the candidate issues listed below. Double-check each one using the zoomed crops. For each candidate decide: confirm — a real, physical build issue — or reject — explained by camera viewpoint, lighting, shadow, reflection, image blur, or a posable part (hinged leaves, arms, movable elements) that is simply positioned differently. Reject only when you can clearly explain the report away; if you are genuinely unsure, confirm. The magenta circle in each build crop marks the exact reported spot. If a confirmed issue\'s pin is misplaced, include refined x/y percentages relative to the FULL build photo (each crop\'s coverage of the full photo is stated with it). Call verify_build_issues with one decision per candidate.'
    }];

    for (const issue of issues) {
      const buildCrop = await cropAt(buildPath, issue.x, issue.y, true);
      if (!buildCrop) return { issues, verified: false, rejected: [] };
      content.push({
        type: 'text',
        text: `Candidate ${issue.number}: [${issue.type}] ${issue.title} — ${issue.detail} (reported at x=${issue.x}%, y=${issue.y}%). Zoomed build crop covering x ${buildCrop.box[0]}–${buildCrop.box[2]}%, y ${buildCrop.box[1]}–${buildCrop.box[3]}% of the full photo:`
      });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buildCrop.data } });
      if (refPath && aligned) {
        const refCrop = await cropAt(refPath, issue.x, issue.y, false);
        if (refCrop) {
          content.push({ type: 'text', text: `Candidate ${issue.number} — the same region of the reference (aligned to the build photo):` });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refCrop.data } });
        }
      }
    }
    if (refImage && !aligned) {
      content.push({ type: 'text', text: 'Full reference photo for comparison (shot from its own angle — the crops above are from the build photo only):' });
      content.push({ type: 'image', source: { type: 'base64', media_type: refImage.mimeType, data: refImage.data } });
    }

    let toolUse = await callClaude(content, false, VERIFY_TOOL);
    if (!toolUse) toolUse = await callClaude(content, true, VERIFY_TOOL);
    const decisions = toolUse?.input?.decisions;
    if (!Array.isArray(decisions)) return { issues, verified: false, rejected: [] };

    const verdictByNumber = new Map(decisions.map(d => [d.number, d]));
    const kept = issues.filter(issue => (verdictByNumber.get(issue.number)?.verdict || 'confirm') !== 'reject');
    // Keep what this pass threw away. Without it, a defect the eval says was
    // missed is unattributable: it could be a first-pass miss or a wrongly
    // rejected candidate, and those call for opposite fixes.
    const rejected = issues
      .filter(issue => verdictByNumber.get(issue.number)?.verdict === 'reject')
      .map(issue => ({
        type: issue.type,
        title: issue.title,
        x: issue.x,
        y: issue.y,
        reason: verdictByNumber.get(issue.number)?.reason || ''
      }));
    for (const issue of kept) {
      const decision = verdictByNumber.get(issue.number);
      if (decision && Number.isFinite(decision.x) && Number.isFinite(decision.y)) {
        issue.x = Math.min(92, Math.max(8, Math.round(decision.x)));
        issue.y = Math.min(88, Math.max(12, Math.round(decision.y)));
      }
    }
    kept.forEach((issue, index) => { issue.number = index + 1; });
    return { issues: kept, verified: true, rejected };
  } catch {
    return { issues, verified: false, rejected: [] };
  } finally {
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// Set inventories are static reference data, so one fetch per set per process
// is plenty. The app holds no other state; losing this on restart just means
// refetching.
const inventoryCache = new Map();
const REBRICKABLE_KEY = process.env.REBRICKABLE_API_KEY || '';

async function fetchSetInventory(setNumber) {
  if (!REBRICKABLE_KEY || !setNumber) return null;
  if (inventoryCache.has(setNumber)) return inventoryCache.get(setNumber);
  try {
    // Rebrickable set numbers carry a variant suffix; "-1" is the standard one.
    const url = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNumber)}-1/parts/?page_size=1000&inc_minifig_parts=0`;
    const response = await fetch(url, {
      headers: { Authorization: `key ${REBRICKABLE_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      inventoryCache.set(setNumber, null);
      return null;
    }
    const payload = await response.json();
    const parts = (payload.results || [])
      .filter(row => row && row.part && !row.is_spare)
      .map(row => ({
        partNum: String(row.part.part_num),
        name: String(row.part.name || ''),
        colorName: String(row.color?.name || ''),
        elementId: row.element_id ? String(row.element_id) : null,
        quantity: row.quantity || 1,
        imageUrl: row.part.part_img_url || null
      }));
    const result = parts.length ? parts : null;
    inventoryCache.set(setNumber, result);
    return result;
  } catch {
    return null;
  }
}

// Two ideas here, and the second was measured rather than assumed.
//
// The enum is what stops invention. Asked to recall a part number the model
// makes up plausible ones; asked to choose from this set's actual inventory it
// is answering multiple choice, and anything off-list is rejected by the API
// before it reaches the user.
//
// Asking for a SHORTLIST rather than one answer is what makes it accurate.
// Forced to commit to a single part it was wrong 4 times out of 4 on a missing
// drum foot, picking a thin dark-blue plate for a tall pale-blue brick. Asked
// for up to three candidates, the right part appeared 3 times out of 4 and was
// ranked first every one of those times — same model, same inventory, same
// issue text. Committing is the hard part; ranking is not. The user settles it
// from thumbnails in a second.
//
// Passing the build photo into this pass was tried twice and made it worse
// (2/4, the failures being empty answers), so this stays text-only.
function buildPartsTool(inventory) {
  const partNums = [...new Set(inventory.map(p => p.partNum))].slice(0, 400);
  return {
    tool: {
      name: 'shortlist_parts',
      description: 'Shortlist the parts from this set that each reported issue could concern.',
      input_schema: {
        type: 'object',
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer', description: 'The issue number being matched' },
                candidates: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 3,
                  description: 'Up to 3 candidate parts from this set, most likely first.',
                  items: { type: 'string', enum: partNums }
                }
              },
              required: ['number', 'candidates']
            }
          }
        },
        required: ['matches']
      }
    },
    partNums
  };
}

async function identifyParts(issues, inventory) {
  const wanted = issues.filter(i => i.type === 'MISSING PIECE' || i.type === 'WRONG PIECE');
  if (!wanted.length || !inventory?.length) return [];
  try {
    const { tool, partNums } = buildPartsTool(inventory);
    const allowed = new Set(partNums);
    const catalogue = inventory
      .filter(p => allowed.has(p.partNum))
      .map(p => `${p.partNum} | ${p.name} | ${p.colorName} | qty ${p.quantity}`)
      .join('\n');

    const toolUse = await callClaude([{
      type: 'text',
      text: `A LEGO build was checked against its reference and these issues were found:\n\n${
        wanted.map(i => `Issue ${i.number}: [${i.type}] ${i.title} — ${i.detail}`).join('\n')
      }\n\nBelow is the complete parts inventory of the set, as "part number | name | colour | quantity":\n\n${catalogue}\n\nFor each issue, shortlist up to 3 inventory parts it could be, most likely first. Match on shape, colour and quantity — a symmetric pair is likely a part with quantity 2, a "Brick Round" is tall where a "Plate Round" is thin and a "Tile Round" has no stud, and colours that read similarly in words ("Blue" vs "Bright Light Blue") are different parts. Include every plausible candidate rather than committing to one; the user picks the right one from pictures.`
    }], false, tool);

    const matches = Array.isArray(toolUse?.input?.matches) ? toolUse.input.matches : [];
    return matches.map(match => {
      const candidates = Array.isArray(match.candidates) ? match.candidates : [];
      const options = [];
      for (const partNum of candidates.slice(0, 3)) {
        // One part number can appear in several colours; each colour is a
        // different element ID and a different thing to order, so offer them
        // all and let the picture decide.
        for (const row of inventory.filter(p => p.partNum === partNum)) {
          if (options.some(o => o.elementId === row.elementId && o.partNum === row.partNum)) continue;
          options.push({
            partNum: row.partNum,
            elementId: row.elementId,
            name: row.name,
            colorName: row.colorName,
            imageUrl: row.imageUrl
          });
        }
      }
      return options.length ? { number: match.number, options: options.slice(0, 4) } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function buildPrompt(instructions) {
  // Everything the instruction page told us is appended as extra grounding.
  // The comparison itself is unchanged, so a build with no instruction page
  // behaves exactly as before.
  let context = '';
  if (instructions) {
    const bits = [];
    if (instructions.setName || instructions.setNumber) {
      bits.push(`the set is ${[instructions.setName, instructions.setNumber].filter(Boolean).join(' ')}`);
    }
    if (instructions.stepNumber) bits.push(`image 2 shows build step ${instructions.stepNumber}`);
    if (instructions.partsCallout?.length) {
      bits.push(`the printed parts callout for this step lists: ${
        instructions.partsCallout.map(p => `${p.quantity ? p.quantity + 'x ' : ''}${p.description}`).join(', ')
      }`);
    }
    if (bits.length) {
      context = ` Additional context read from the instruction page: ${bits.join('; ')}. Use the callout to judge which pieces should be present at this step — a piece that belongs to a LATER step is not missing.`;
    }
  }
  return `You are an expert LEGO build reviewer. Image 1 is the user's current build. Image 2 is the correct reference or instruction step.${context} Compare them carefully and list every visible difference: missing pieces, wrong pieces, wrong colors, wrong orientation, or pieces in the wrong place. ${VIEWPOINT_GUARD} Describe each fix using the actual colors, shapes, and locations you see in the photos. Only report issues you can clearly see. ${SCAN_INSTRUCTION} If the build matches the reference, call the tool with an empty issues array.`;
}

async function callClaude(content, forceTool, tool = REPORT_ISSUES_TOOL) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content }],
      tools: [tool],
      tool_choice: forceTool ? { type: 'tool', name: tool.name } : { type: 'auto' }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'The vision service could not analyse this photo.');
  }
  return payload.content?.find(block => block.type === 'tool_use' && block.name === tool.name) || null;
}

async function analyse(image, referenceImage, referenceKind) {
  if (!image) throw new Error('Please upload a photo of your build first.');
  if (!referenceImage) throw new Error('Please add a reference photo showing how the build should look.');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured. Copy .env.example to .env, add ANTHROPIC_API_KEY, then restart the server.');
  }

  // Opt-in: only when the user chose "upload instruction page". Costs one
  // extra call, and every downstream use of it degrades to nothing if it fails.
  const instructions = referenceKind === 'instructions' ? await readInstructionPage(referenceImage) : null;

  let aligned = false;
  let alignReason = null;
  let referenceToSend = referenceImage;
  let diffRegions = [];
  {
    const alignment = await alignReferenceToBuild(image, referenceImage);
    if (alignment.success) {
      referenceToSend = `data:${alignment.mime};base64,${alignment.image_base64}`;
      aligned = true;
      diffRegions = Array.isArray(alignment.regions) ? alignment.regions.slice(0, 4) : [];
    } else {
      // Alignment failed (no python/opencv, frame not detected, photos too
      // different, etc.) — fall back to the original photos, but keep the
      // reason so the UI can explain why results might be less precise.
      alignReason = alignment.reason === 'unavailable'
        ? "Photo alignment isn't installed on this server."
        : alignment.reason;
    }
  }

  const content = [{ type: 'text', text: buildPrompt(instructions) }];

  const mainImage = parseDataUrl(image);
  if (!SUPPORTED_MEDIA_TYPES.has(mainImage.mimeType)) {
    throw new Error(`This photo is in a format the analysis service can't read (${mainImage.mimeType}). Please use a JPG, PNG, WebP, or GIF.`);
  }
  // Send Claude a gridded copy of the build photo when possible — pins get
  // read off the grid instead of estimated. The UI keeps the clean photo.
  const gridded = await overlayGrid(image);
  content.push({ type: 'text', text: gridded
    ? 'Image 1 (the user\'s current build). A thin magenta coordinate grid is overlaid on this photo: lines every 10 percent, labeled with percentage values along the top and left edges. Use the grid to read off precise x/y values for each issue. The grid is an overlay only — it is not part of the build:'
    : 'Image 1 (the user\'s current build):' });
  content.push({ type: 'image', source: { type: 'base64', media_type: (gridded || mainImage).mimeType, data: (gridded || mainImage).data } });

  if (referenceToSend) {
    const refImage = parseDataUrl(referenceToSend);
    if (!SUPPORTED_MEDIA_TYPES.has(refImage.mimeType)) {
      throw new Error(`The reference image is in a format the analysis service can't read (${refImage.mimeType}). Please use a JPG, PNG, WebP, or GIF.`);
    }
    content.push({ type: 'text', text: aligned
      ? 'Image 2 (the reference / instruction step, auto-aligned and color-corrected to match image 1\'s angle and lighting):'
      : 'Image 2 (the reference / instruction step):' });
    content.push({ type: 'image', source: { type: 'base64', media_type: refImage.mimeType, data: refImage.data } });
  }

  // When alignment succeeded, a pixel-level diff of the registered photos
  // flags candidate difference spots. Zoomed crop pairs of those spots make
  // small defects (one missing brick in a huge mosaic) far easier to verify
  // than scanning the full image.
  if (diffRegions.length) {
    content.push({
      type: 'text',
      text: `Automated pixel comparison of the two aligned photos flagged ${diffRegions.length} candidate region(s) where they differ. Each candidate below shows two zoomed crops of the same spot: first from the user's build, then from the reference. Judge each pair: if the difference is a real build mistake (missing, wrong, misplaced, or rotated piece), include it in your report using the candidate's stated x/y coordinates; if it is just a photography artifact (glare, shadow, reflection, blur, alignment ghosting), ignore it. Also still scan the full photos for issues the automated pass may have missed.`
    });
    diffRegions.forEach((region, index) => {
      content.push({ type: 'text', text: `Candidate ${index + 1} — centered at x=${region.x}%, y=${region.y}% of image 1. The user's build at this spot:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: region.build_crop } });
      content.push({ type: 'text', text: `Candidate ${index + 1} — what the reference shows at the same spot:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: region.ref_crop } });
    });
  }

  // tool_choice "auto" lets Claude write out its region-by-region inspection
  // before committing to the structured result — forcing the tool call skips
  // that reasoning pass and measurably hurts detection, especially near the
  // edges of the photo. If it ever answers without calling the tool, retry
  // once with the tool call forced.
  let toolUse = await callClaude(content, false);
  if (!toolUse) toolUse = await callClaude(content, true);
  if (!toolUse) throw new Error('The vision service returned an unexpected response.');

  const firstPass = normalizeIssues(toolUse.input?.issues);
  const { issues, verified, rejected } = await verifyIssues(firstPass, image, referenceToSend, aligned);

  // Parts identification runs last, on confirmed issues only, and never
  // touches detection. If there is no set number, no API key, or no match, the
  // result is simply an analysis without part codes.
  const inventory = await fetchSetInventory(instructions?.setNumber);
  const parts = inventory ? await identifyParts(issues, inventory) : [];
  const partByIssue = new Map(parts.map(p => [p.number, p]));
  for (const issue of issues) {
    const match = partByIssue.get(issue.number);
    // A ranked shortlist, best first — not an answer. The UI presents these as
    // candidates to pick between, because committing to one is the step the
    // model measurably cannot do.
    if (match) issue.parts = match.options;
  }

  return {
    issues,
    verified,
    mode: 'live',
    aligned,
    alignReason,
    // Null unless an instruction page was uploaded AND a set number was
    // literally printed on it. Never inferred from the model in the photo.
    set: instructions?.setNumber
      ? { number: instructions.setNumber, name: instructions.setName || null, step: instructions.stepNumber || null }
      : null,
    // 'catalogue' means every code came from the set's real inventory.
    // 'none' means we could not look parts up, and the UI must not invent any.
    partsSource: inventory ? 'catalogue' : 'none',
    // Drives whether the UI offers to report a wrong answer. Hidden entirely
    // when there is nowhere to store one, so the offer is never made falsely.
    feedback: feedbackEnabled(),
    // When alignment succeeded, the warped reference shares the build photo's
    // coordinate system — the client uses it to crop matching "yours vs
    // target" regions around each issue.
    alignedReference: aligned ? referenceToSend : null,
    // Candidates the verification pass discarded, so a missed defect can be
    // attributed to the right stage rather than guessed at.
    rejected
  };
}

http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BrickCheck", charset="UTF-8"' });
    return res.end('Authentication required.');
  }
  if (req.method === 'POST' && req.url === '/api/analyze') {
    if (rateLimited(clientIp(req))) {
      return send(res, 429, { error: 'Too many analyses in a short time — wait a minute and try again.' });
    }
    try { const { image, referenceImage, referenceKind } = await readBody(req); return send(res, 200, await analyse(image, referenceImage, referenceKind)); }
    catch (error) {
      send(res, error.statusCode || 400, { error: error.message });
      // An over-sized upload was paused rather than read to completion —
      // close it now that the client has its answer.
      if (!req.readableEnded) req.destroy();
      return;
    }
  }
  if (req.method === 'POST' && req.url === '/api/feedback') {
    if (!feedbackEnabled()) {
      return send(res, 501, { error: 'Feedback collection is not enabled on this server.' });
    }
    if (rateLimited(clientIp(req))) {
      return send(res, 429, { error: 'Too many reports in a short time — wait a minute and try again.' });
    }
    try {
      const body = await readBody(req);
      const build = parseDataUrl(body.image);
      const reference = body.referenceImage ? parseDataUrl(body.referenceImage) : null;
      const id = await saveFeedback({
        build: { buffer: Buffer.from(build.data, 'base64'), mimeType: build.mimeType },
        reference: reference && { buffer: Buffer.from(reference.data, 'base64'), mimeType: reference.mimeType },
        meta: {
          reportedAt: new Date().toISOString(),
          referenceKind: body.referenceKind === 'instructions' ? 'instructions' : 'photo',
          // What the user says was wrong, in their words — the label that
          // makes this submission usable as an eval case later.
          note: String(body.note || '').slice(0, 2000),
          // The analysis as the user saw it. Client-supplied, so it is stored
          // as a record of what was shown, never trusted as input to anything.
          reported: body.analysis || null
        }
      });
      return send(res, 200, { ok: true, id });
    } catch (error) {
      send(res, error.statusCode || 400, { error: error.message });
      if (!req.readableEnded) req.destroy();
      return;
    }
  }
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (!STATIC_FILES.has(file)) return send(res, 404, 'Not found', 'text/plain');
  const target = path.resolve(root, `.${file}`);
  if (!target.startsWith(root) || !fs.existsSync(target)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(target), mime[path.extname(target)] || 'application/octet-stream');
// Binding all interfaces is right inside a container, but on a laptop it
// also offers the app to every device on whatever network you have joined.
// Set HOST=127.0.0.1 to keep it on loopback and expose it deliberately
// instead (e.g. `tailscale serve`).
}).listen(process.env.PORT || 3000, process.env.HOST || '0.0.0.0', async () => {
  alignmentAvailable = await checkAlignmentAvailable();
  console.log(`BrickCheck is ready at http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`);
  console.log(process.env.ANTHROPIC_API_KEY ? `Live analysis enabled (${CLAUDE_MODEL}).` : 'No ANTHROPIC_API_KEY found — add it to .env to analyse photos.');
  console.log(alignmentAvailable
    ? 'Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.'
    : 'Image processing DISABLED (python3/opencv/scikit-image not found) — alignment, the coordinate grid and issue verification are all off, which markedly reduces accuracy. Install preprocess/requirements.txt to enable them.');
  console.log(feedbackEnabled()
    ? `Feedback collection enabled — reported mistakes are saved to ${feedbackTarget()}.`
    : 'Feedback collection disabled (no FEEDBACK_BUCKET) — the "this looks wrong" button is hidden and no photos are ever stored.');
  console.log(REBRICKABLE_KEY
    ? 'Brick codes enabled — an uploaded instruction page with a printed set number will list the exact parts to order.'
    : 'Brick codes disabled (no REBRICKABLE_API_KEY) — instruction pages still improve the check, but issues will link to a parts search instead of naming exact codes.');
  console.log(APP_PASSWORD
    ? 'Password protection enabled (APP_PASSWORD).'
    : 'No APP_PASSWORD set — anyone who can reach this server can spend your API credit. Set one before exposing it beyond localhost.');
});
