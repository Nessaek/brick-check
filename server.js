const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC_FILES = new Set(['/index.html', '/app.js', '/styles.css']);

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
function rateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
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
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 15_000_000) reject(new Error('Image is too large.')); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid request body.')); }
    });
    req.on('error', reject);
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
async function verifyIssues(issues, image, referenceToSend, aligned, hasReference) {
  if (!issues.length || !alignmentAvailable) return { issues, verified: false };

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickcheck-verify-'));
    const main = parseDataUrl(image);
    const buildPath = path.join(tmpDir, `build${EXT_BY_MIME[main.mimeType] || '.img'}`);
    fs.writeFileSync(buildPath, Buffer.from(main.data, 'base64'));
    let refPath = null;
    let refImage = null;
    if (hasReference && referenceToSend) {
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
      if (!buildCrop) return { issues, verified: false };
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
    if (!Array.isArray(decisions)) return { issues, verified: false };

    const verdictByNumber = new Map(decisions.map(d => [d.number, d]));
    const kept = issues.filter(issue => (verdictByNumber.get(issue.number)?.verdict || 'confirm') !== 'reject');
    for (const issue of kept) {
      const decision = verdictByNumber.get(issue.number);
      if (decision && Number.isFinite(decision.x) && Number.isFinite(decision.y)) {
        issue.x = Math.min(92, Math.max(8, Math.round(decision.x)));
        issue.y = Math.min(88, Math.max(12, Math.round(decision.y)));
      }
    }
    kept.forEach((issue, index) => { issue.number = index + 1; });
    return { issues: kept, verified: true };
  } catch {
    return { issues, verified: false };
  } finally {
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

function buildPrompt(hasReference) {
  return hasReference
    ? `You are an expert LEGO build reviewer. Image 1 is the user's current build. Image 2 is the correct reference or instruction step. Compare them carefully and list every visible difference: missing pieces, wrong pieces, wrong colors, wrong orientation, or pieces in the wrong place. ${VIEWPOINT_GUARD} Describe each fix using the actual colors, shapes, and locations you see in the photos. Only report issues you can clearly see. ${SCAN_INSTRUCTION} If the build matches the reference, call the tool with an empty issues array.`
    : `You are an expert LEGO build reviewer. Image 1 is the user's current build. No reference image was provided, so inspect the build for obvious mistakes: missing pieces leaving gaps or exposed studs, pieces facing the wrong way, wrong colors for the section, unstable or floating parts, or incomplete sub-assemblies. Only report issues you can clearly see. Describe each fix using the actual colors, shapes, and locations visible in the photo. ${SCAN_INSTRUCTION} If nothing looks clearly wrong, call the tool with an empty issues array.`;
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

async function analyse(image, referenceImage) {
  if (!image) throw new Error('Please upload a photo of your build first.');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured. Copy .env.example to .env, add ANTHROPIC_API_KEY, then restart the server.');
  }

  let aligned = false;
  let alignReason = null;
  let referenceToSend = referenceImage;
  let diffRegions = [];
  if (referenceImage) {
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

  const content = [{ type: 'text', text: buildPrompt(Boolean(referenceImage)) }];

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
  const { issues, verified } = await verifyIssues(firstPass, image, referenceToSend, aligned, Boolean(referenceImage));

  return {
    issues,
    verified,
    mode: 'live',
    hasReference: Boolean(referenceImage),
    aligned,
    alignReason,
    // When alignment succeeded, the warped reference shares the build photo's
    // coordinate system — the client uses it to crop matching "yours vs
    // target" regions around each issue.
    alignedReference: aligned ? referenceToSend : null
  };
}

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') {
    if (rateLimited(req.socket.remoteAddress)) {
      return send(res, 429, { error: 'Too many analyses in a short time — wait a minute and try again.' });
    }
    try { const { image, referenceImage } = await readBody(req); return send(res, 200, await analyse(image, referenceImage)); }
    catch (error) { return send(res, 400, { error: error.message }); }
  }
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (!STATIC_FILES.has(file)) return send(res, 404, 'Not found', 'text/plain');
  const target = path.resolve(root, `.${file}`);
  if (!target.startsWith(root) || !fs.existsSync(target)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(target), mime[path.extname(target)] || 'application/octet-stream');
}).listen(process.env.PORT || 3000, async () => {
  alignmentAvailable = await checkAlignmentAvailable();
  console.log(`BrickCheck is ready at http://localhost:${process.env.PORT || 3000}`);
  console.log(process.env.ANTHROPIC_API_KEY ? `Live analysis enabled (${CLAUDE_MODEL}).` : 'No ANTHROPIC_API_KEY found — add it to .env to analyse photos.');
  console.log(alignmentAvailable
    ? 'Photo alignment enabled — reference photos will be auto-aligned to the build photo before comparison.'
    : 'Photo alignment disabled (python3/opencv/scikit-image not found) — install preprocess/requirements.txt to enable it.');
});
