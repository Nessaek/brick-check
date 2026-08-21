const upload = document.querySelector('#build-upload');
const dropZone = document.querySelector('#drop-zone');
const previewWrap = document.querySelector('#preview-wrap');
const preview = document.querySelector('#preview');
const remove = document.querySelector('#remove-image');
const analyze = document.querySelector('#analyze');
const results = document.querySelector('#results');
const loading = document.querySelector('#loading');
const uploadStatus = document.querySelector('#upload-status');
let uploadedImage = '';
let referenceImage = '';
let alignedReference = '';
let previewUrl = '';
const referenceUpload = document.querySelector('#reference-upload');
const instructionUpload = document.querySelector('#instruction-upload');
let referenceKind = 'photo';
let lastIssues = [];
const imageExtensions = /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i;

function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  return imageExtensions.test(file.name);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read this photo.'));
    reader.readAsDataURL(file);
  });
}

// Re-encode to a downscaled JPEG before upload. Claude's vision API tops out
// around 1568px of useful resolution, so bigger photos only add cost and
// upload time — and formats the API rejects (HEIC from iPhones) get converted
// wherever the browser can decode them. Falls back to the raw file if the
// browser can't decode it; the server then reports the unsupported format.
async function fileToUploadDataURL(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return readFileAsDataURL(file);
  }
}

function setUploadStatus(message, isError = false) {
  if (!uploadStatus) return;
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle('error', isError);
  uploadStatus.classList.toggle('hidden', !message);
}

// Both photos are required: the whole method is a comparison, and without a
// reference there is nothing to compare against.
function refreshAnalyzeState() {
  const ready = Boolean(uploadedImage && referenceImage);
  analyze.disabled = !ready;
  analyze.setAttribute('aria-disabled', ready ? 'false' : 'true');
  analyze.title = ready ? '' : 'Add both your build photo and a reference photo first';
}

refreshAnalyzeState();
if (location.protocol === 'file:') {
  setUploadStatus('Open http://localhost:3000 after running npm start — opening index.html directly will not work.', true);
}

async function showImage(file) {
  if (!isImageFile(file)) {
    setUploadStatus('Please choose a JPG, PNG, or HEIC photo.', true);
    return;
  }
  setUploadStatus('Loading photo…');
  refreshAnalyzeState();
  try {
    uploadedImage = await fileToUploadDataURL(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.onerror = () => {
      preview.removeAttribute('src');
      setUploadStatus('Photo selected. Preview is unavailable for this format, but analysis will still use your file.');
    };
    preview.onload = () => setUploadStatus('');
    previewWrap.classList.remove('hidden');
    dropZone.classList.add('hidden');
    refreshAnalyzeState();
  } catch (error) {
    uploadedImage = '';
    setUploadStatus(error.message, true);
  }
}

upload.addEventListener('change', e => showImage(e.target.files[0]));
['dragenter', 'dragover'].forEach(event => dropZone.addEventListener(event, e => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(event => dropZone.addEventListener(event, e => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', e => showImage(e.dataTransfer.files[0]));
remove.addEventListener('click', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  preview.src = '';
  preview.onerror = null;
  preview.onload = null;
  uploadedImage = '';
  upload.value = '';
  previewWrap.classList.add('hidden');
  dropZone.classList.remove('hidden');
  refreshAnalyzeState();
  setUploadStatus('');
});

const referenceImageArea = document.querySelector('.reference-image');
const referenceDefaults = {
  image: referenceImageArea.innerHTML,
  title: document.querySelector('#reference-title').textContent,
  status: document.querySelector('#reference-status').textContent
};

async function setReference(file, label, kind) {
  if (!isImageFile(file)) return;
  referenceKind = kind || 'photo';
  referenceImage = await fileToUploadDataURL(file);
  referenceImageArea.innerHTML = `<img src="${referenceImage}" alt="Selected build reference">`;
  document.querySelector('#reference-title').textContent = label;
  document.querySelector('#reference-status').textContent = 'Ready to compare with your build';
  document.querySelector('#remove-ref').hidden = false;
  refreshAnalyzeState();
}
function clearReference() {
  referenceImage = '';
  referenceKind = 'photo';
  alignedReference = '';
  referenceUpload.value = '';
  instructionUpload.value = '';
  referenceImageArea.innerHTML = referenceDefaults.image;
  document.querySelector('#reference-title').textContent = referenceDefaults.title;
  document.querySelector('#reference-status').textContent = referenceDefaults.status;
  document.querySelector('#remove-ref').hidden = true;
  refreshAnalyzeState();
}
document.querySelector('#change-ref').addEventListener('click', () => referenceUpload.click());
document.querySelector('#remove-ref').addEventListener('click', clearReference);
document.querySelector('#upload-instructions').addEventListener('click', () => instructionUpload.click());
referenceUpload.addEventListener('change', event => setReference(event.target.files[0], 'Custom reference image', 'photo'));
// The kind is not cosmetic: it is what opts this analysis into reading the
// page for a set number, which in turn is what unlocks the parts list.
instructionUpload.addEventListener('change', event => setReference(event.target.files[0], 'Instruction page uploaded', 'instructions'));

analyze.addEventListener('click', async () => {
  if (!uploadedImage) {
    setUploadStatus('Upload a photo of your build before analyzing.', true);
    return;
  }
  if (!referenceImage) {
    setUploadStatus('Add a reference photo showing how the build should look.', true);
    return;
  }
  if (location.protocol === 'file:') {
    setUploadStatus('Start the app with npm start and open http://localhost:3000.', true);
    return;
  }
  loading.classList.remove('hidden');
  try {
    const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: uploadedImage, referenceImage, referenceKind }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Analysis failed.');
    alignedReference = data.alignedReference || '';
    renderIssues(data.issues, data.mode, data.aligned, data.alignReason, data.verified);
    lastIssues = data.issues || [];
    renderParts(data.issues, data.set, data.partsSource);
    showReportOption(data);
  } catch (error) {
    renderIssues([], 'error');
    showReportOption(null);
    document.querySelector('.results-heading p').textContent = error.message;
  } finally {
    loading.classList.add('hidden');
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

function renderIssues(issues, mode, aligned = false, alignReason = null, verified = false) {
  const heading = document.querySelector('.results-heading p');
  const list = document.querySelector('.issues');
  const mapImage = document.querySelector('#map-image');
  const mapCount = document.querySelector('.map-top span');

  if (mode === 'live' && !issues.length) {
    heading.textContent = 'Your build matches the reference — no differences found.';
  } else if (issues.length) {
    heading.innerHTML = `We found <b>${issues.length} issue${issues.length === 1 ? '' : 's'}</b> in your build photo.`;
  } else {
    heading.textContent = 'No issues to show.';
  }

  if (aligned) {
    heading.innerHTML += ' <span class="align-note">Reference photo auto-aligned and color-corrected for a fairer comparison.</span>';
  } else if (alignReason) {
    heading.innerHTML += ` <span class="align-note">${escapeHtml(alignReason)}</span>`;
  }
  if (verified && issues.length) {
    heading.innerHTML += ' <span class="align-note">Each issue was double-checked on a zoomed close-up.</span>';
  }

  mapCount.innerHTML = issues.length ? `<i></i> ${issues.length} issue${issues.length === 1 ? '' : 's'} marked` : 'No issues marked';
  mapImage.innerHTML = uploadedImage
    ? `<img class="map-photo" src="${uploadedImage}" alt="Your uploaded LEGO build">${issues.map((issue, index) => `<button class="pin ${index === 0 ? 'active-pin' : ''}" data-pin="${issue.number}" style="left:${issue.x}%;top:${issue.y}%">${issue.number}</button>`).join('')}`
    : '';

  const refUrl = alignedReference || referenceImage;
  // A same-coordinates crop of the reference only lines up with the build
  // when the reference was aligned onto it. Otherwise the crop would land on
  // whatever happens to be at those coordinates in a differently-framed
  // photo — usually background — so show the whole reference instead.
  const refCaption = aligned ? 'Should look like' : 'Reference photo';
  const compareStrip = refUrl
    ? `<div class="compare"><figure><canvas class="crop"></canvas><figcaption>Your build</figcaption></figure><figure><canvas class="crop"></canvas><figcaption>${refCaption}</figcaption></figure></div>`
    : '<div class="compare"><figure><canvas class="crop"></canvas><figcaption>Look here</figcaption></figure></div>';
  list.innerHTML = issues.map((issue, index) => `<article class="issue ${index === 0 ? 'active' : ''}" data-pin="${issue.number}"><div class="issue-number">${issue.number}</div><div><span class="severity ${severityClass(issue.type)}">${issue.type}</span><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.detail)}</p>${compareStrip}<div class="fix-visual"><span class="mini-brick ${issue.color || 'grey'}"></span><span>${escapeHtml(issue.action || 'Fix this')} <b>→</b></span></div></div><button class="chevron">⌄</button></article>`).join('');

  renderIssueCrops(issues, refUrl, aligned);
  bindResultInteractions();
}

// Draw a zoomed crop of each issue's location — from the build photo, and
// (when a reference exists) the same region of the reference. If the server
// aligned the reference onto the build photo's perspective, the two crops
// line up brick-for-brick; otherwise the reference crop is approximate.
async function renderIssueCrops(issues, refUrl, aligned) {
  if (!uploadedImage || !issues.length) return;
  try {
    const buildImg = new Image();
    buildImg.src = uploadedImage;
    const loads = [buildImg.decode()];
    let refImg = null;
    if (refUrl) {
      refImg = new Image();
      refImg.src = refUrl;
      loads.push(refImg.decode());
    }
    await Promise.all(loads);
    document.querySelectorAll('.issue').forEach(card => {
      const issue = issues.find(item => String(item.number) === card.dataset.pin);
      if (!issue) return;
      const canvases = card.querySelectorAll('canvas.crop');
      if (canvases[0]) drawCrop(canvases[0], buildImg, issue.x, issue.y, true);
      if (canvases[1] && refImg) {
        if (aligned) drawCrop(canvases[1], refImg, issue.x, issue.y, false);
        else drawWhole(canvases[1], refImg);
      }
    });
  } catch {
    // Crops are a bonus — if an image fails to decode, the cards still work.
  }
}

function prepareCanvas(canvas) {
  const size = 150;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return { ctx, dpr };
}

// Fits a whole photo into the square canvas, letterboxed.
function drawWhole(canvas, img) {
  const { ctx } = prepareCanvas(canvas);
  const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function drawCrop(canvas, img, xPct, yPct, markSpot) {
  const { ctx, dpr } = prepareCanvas(canvas);
  const side = Math.min(img.naturalWidth, img.naturalHeight) * 0.32;
  const sx = Math.max(0, Math.min(img.naturalWidth - side, img.naturalWidth * xPct / 100 - side / 2));
  const sy = Math.max(0, Math.min(img.naturalHeight - side, img.naturalHeight * yPct / 100 - side / 2));
  ctx.drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
  if (markSpot) {
    const cx = (img.naturalWidth * xPct / 100 - sx) / side * canvas.width;
    const cy = (img.naturalHeight * yPct / 100 - sy) / side * canvas.height;
    ctx.strokeStyle = 'rgba(235, 60, 60, 0.95)';
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, 15 * dpr, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function severityClass(type = '') {
  if (type.includes('ORIENTATION')) return 'amber';
  if (type.includes('WRONG PIECE')) return 'purple';
  return '';
}

// The shopping list. Deliberately shows nothing at all unless a set number was
// read off an instruction page — a plausible-looking wrong part code is worse
// than no code, because the user finds out by receiving the wrong brick.
//
// Candidates, not answers. Asked to name one part the model was wrong every
// time on a test defect; asked to rank three it put the right one first. So
// the pictures go to the user and the user decides — the part of this that a
// human does instantly and the model does badly.
function renderParts(issues, set, partsSource) {
  const panel = document.querySelector('#parts-panel');
  if (!panel) return;
  const list = (issues || []).filter(issue => issue.parts && issue.parts.length);

  if (!set) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const setLabel = escapeHtml([set.name, set.number].filter(Boolean).join(' \u00b7 '));
  const stepLabel = set.step ? ` \u00b7 step ${escapeHtml(set.step)}` : '';
  let body;

  if (list.length) {
    body = `<ul class="parts-list">${list.map(issue => {
      const options = issue.parts;
      const picker = options.map((part, index) => `
        <button class="part-option ${index === 0 ? 'selected' : ''}" data-issue="${issue.number}" data-index="${index}"
                title="${escapeHtml(`${part.name} — ${part.colorName}`)}" aria-pressed="${index === 0}">
          ${part.imageUrl ? `<img src="${escapeHtml(part.imageUrl)}" alt="${escapeHtml(part.name)}" loading="lazy" />` : '<span class="parts-thumb-blank"></span>'}
        </button>`).join('');
      return `<li data-issue="${issue.number}">
        <div class="part-options">${picker}</div>
        <div class="part-detail">
          <b></b>
          <span></span>
        </div>
        <div class="parts-code"></div>
        <a href="#" target="_blank" rel="noopener noreferrer">Find it \u2192</a>
      </li>`;
    }).join('')}</ul>
    <p class="parts-note">${list.length === 1 ? 'One piece' : `${list.length} pieces`} to replace. Tap a picture if a different one matches your brick.</p>`;
  } else if (partsSource === 'catalogue') {
    // "Nothing to order" and "couldn't match it" are different answers, and
    // conflating them would tell someone with a missing brick that they need
    // nothing. Matching declines rather than guesses, so this happens.
    const needsParts = (issues || []).some(i => i.type === 'MISSING PIECE' || i.type === 'WRONG PIECE');
    body = needsParts
      ? '<p class="parts-empty">Couldn\'t narrow these down to specific parts \u2014 browse the set\'s inventory below.</p>'
        + `<a class="parts-browse" href="https://rebrickable.com/sets/${encodeURIComponent(set.number)}-1/" target="_blank" rel="noopener noreferrer">Browse every part in ${escapeHtml(set.number)} \u2192</a>`
      : '<p class="parts-empty">No missing or wrong pieces to order for this build.</p>';
  } else {
    body = `<p class="parts-empty">Exact part codes aren\'t configured on this server, but you can browse every piece in this set.</p>
      <a class="parts-browse" href="https://rebrickable.com/sets/${encodeURIComponent(set.number)}-1/" target="_blank" rel="noopener noreferrer">Browse the parts list for ${escapeHtml(set.number)} \u2192</a>`;
  }

  panel.hidden = false;
  panel.innerHTML = `<div class="parts-heading"><h3>Bricks you need</h3><span>${setLabel}${stepLabel}</span></div>${body}`;
  list.forEach(issue => selectPart(issue, 0));
}

// Writes the chosen candidate into its row. Element ID is part + colour, and
// is what LEGO's own replacement service takes; a design ID alone does not
// specify a colour, so it is only the fallback.
function selectPart(issue, index) {
  const row = document.querySelector(`.parts-list li[data-issue="${issue.number}"]`);
  if (!row) return;
  const part = issue.parts[index];
  if (!part) return;
  row.querySelector('.part-detail b').textContent = part.name;
  row.querySelector('.part-detail span').textContent = `${part.colorName} \u00b7 for issue ${issue.number}`;
  row.querySelector('.parts-code').innerHTML = part.elementId
    ? `<b>${escapeHtml(part.elementId)}</b><span>element ID</span>`
    : `<b>${escapeHtml(part.partNum)}</b><span>design ID</span>`;
  row.querySelector('a').href = `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${encodeURIComponent(part.partNum)}`;
  row.querySelectorAll('.part-option').forEach((button, i) => {
    button.classList.toggle('selected', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
}

// One delegated listener, so it survives every re-render.
document.addEventListener('click', event => {
  const button = event.target.closest('.part-option');
  if (!button) return;
  event.preventDefault();
  const issueNumber = Number(button.dataset.issue);
  const issue = (lastIssues || []).find(i => i.number === issueNumber);
  if (issue) selectPart(issue, Number(button.dataset.index));
});

// "How it works" used to be a button that did nothing, next to an avatar
// implying a signed-in account on a site that has no accounts. On a public URL
// where most visitors have never seen this before, the explanation is worth
// having; the fake account is not.
const howButton = document.querySelector('#how-it-works');
howButton.addEventListener('click', () => {
  const panel = document.querySelector('#how-panel');
  const open = panel.classList.toggle('hidden');
  howButton.setAttribute('aria-expanded', String(!open));
  if (!open) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// Reporting a wrong answer. This is the one path that shares the user's
// photos, so it is opt-in, states plainly what it sends, and is hidden
// entirely when the server has nowhere to put them.
let lastAnalysis = null;

function showReportOption(data) {
  const panel = document.querySelector('#report-wrong');
  if (!panel) return;
  lastAnalysis = data;
  panel.classList.toggle('hidden', !data || !data.feedback);
  document.querySelector('#report-form').classList.add('hidden');
  document.querySelector('#report-prompt-row').classList.remove('hidden');
  document.querySelector('#report-status').classList.add('hidden');
  document.querySelector('#report-note').value = '';
}

document.querySelector('#report-open').addEventListener('click', () => {
  document.querySelector('#report-prompt-row').classList.add('hidden');
  document.querySelector('#report-form').classList.remove('hidden');
  document.querySelector('#report-note').focus();
});

document.querySelector('#report-cancel').addEventListener('click', () => {
  document.querySelector('#report-form').classList.add('hidden');
  document.querySelector('#report-prompt-row').classList.remove('hidden');
});

document.querySelector('#report-send').addEventListener('click', async () => {
  const status = document.querySelector('#report-status');
  const send = document.querySelector('#report-send');
  if (!uploadedImage) return;
  send.disabled = true;
  send.textContent = 'Sending…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: uploadedImage,
        referenceImage,
        referenceKind,
        note: document.querySelector('#report-note').value,
        analysis: lastAnalysis
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not send the report.');
    document.querySelector('#report-form').classList.add('hidden');
    status.textContent = 'Thanks — that helps. The photos and what went wrong have been saved for review.';
    status.classList.remove('hidden');
  } catch (error) {
    status.textContent = error.message;
    status.classList.remove('hidden');
  } finally {
    send.disabled = false;
    send.textContent = 'Send photos and report';
  }
});

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bindResultInteractions() {
  document.querySelectorAll('.issue').forEach(issue => issue.addEventListener('click', () => activateIssue(issue.dataset.pin)));
  document.querySelectorAll('.pin').forEach(pin => pin.addEventListener('click', event => {
    event.stopPropagation();
    activateIssue(pin.dataset.pin);
  }));
}

function activateIssue(pin) {
  document.querySelectorAll('.issue').forEach(item => item.classList.toggle('active', item.dataset.pin === pin));
  // Scaling is handled by the .active-pin CSS rule — setting style.transform
  // here would clobber the translate() that centres the pin on its point.
  document.querySelectorAll('.pin').forEach(item => {
    item.classList.toggle('active-pin', item.dataset.pin === pin);
  });
}
document.querySelector('#new-scan').addEventListener('click', () => { results.classList.add('hidden'); document.querySelector('#workspace').scrollIntoView({ behavior: 'smooth' }); });
document.querySelector('#check-again').addEventListener('click', () => analyze.click());
