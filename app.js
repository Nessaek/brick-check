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

function setAnalyzeReady(ready) {
  analyze.disabled = !ready;
  analyze.setAttribute('aria-disabled', ready ? 'false' : 'true');
}

setAnalyzeReady(false);
if (location.protocol === 'file:') {
  setUploadStatus('Open http://localhost:3000 after running npm start — opening index.html directly will not work.', true);
}

async function showImage(file) {
  if (!isImageFile(file)) {
    setUploadStatus('Please choose a JPG, PNG, or HEIC photo.', true);
    return;
  }
  setUploadStatus('Loading photo…');
  setAnalyzeReady(false);
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
    setAnalyzeReady(true);
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
  setAnalyzeReady(false);
  setUploadStatus('');
});

const referenceImageArea = document.querySelector('.reference-image');
const referenceDefaults = {
  image: referenceImageArea.innerHTML,
  title: document.querySelector('#reference-title').textContent,
  status: document.querySelector('#reference-status').textContent
};

async function setReference(file, label) {
  if (!isImageFile(file)) return;
  referenceImage = await fileToUploadDataURL(file);
  referenceImageArea.innerHTML = `<img src="${referenceImage}" alt="Selected build reference">`;
  document.querySelector('#reference-title').textContent = label;
  document.querySelector('#reference-status').textContent = 'Ready to compare with your build';
  document.querySelector('#remove-ref').hidden = false;
}
function clearReference() {
  referenceImage = '';
  alignedReference = '';
  referenceUpload.value = '';
  instructionUpload.value = '';
  referenceImageArea.innerHTML = referenceDefaults.image;
  document.querySelector('#reference-title').textContent = referenceDefaults.title;
  document.querySelector('#reference-status').textContent = referenceDefaults.status;
  document.querySelector('#remove-ref').hidden = true;
}
document.querySelector('#change-ref').addEventListener('click', () => referenceUpload.click());
document.querySelector('#remove-ref').addEventListener('click', clearReference);
document.querySelector('#upload-instructions').addEventListener('click', () => instructionUpload.click());
referenceUpload.addEventListener('change', event => setReference(event.target.files[0], 'Custom reference image'));
instructionUpload.addEventListener('change', event => setReference(event.target.files[0], 'Instruction page uploaded'));

analyze.addEventListener('click', async () => {
  if (!uploadedImage) {
    setUploadStatus('Upload a photo of your build before analyzing.', true);
    return;
  }
  if (location.protocol === 'file:') {
    setUploadStatus('Start the app with npm start and open http://localhost:3000.', true);
    return;
  }
  loading.classList.remove('hidden');
  try {
    const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: uploadedImage, referenceImage }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Analysis failed.');
    alignedReference = data.alignedReference || '';
    renderIssues(data.issues, data.mode, data.hasReference, data.aligned, data.alignReason, data.verified);
  } catch (error) {
    renderIssues([], 'error');
    document.querySelector('.results-heading p').textContent = error.message;
  } finally {
    loading.classList.add('hidden');
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

function renderIssues(issues, mode, hasReference = Boolean(referenceImage), aligned = false, alignReason = null, verified = false) {
  const heading = document.querySelector('.results-heading p');
  const list = document.querySelector('.issues');
  const mapImage = document.querySelector('#map-image');
  const mapCount = document.querySelector('.map-top span');

  if (mode === 'live' && !issues.length) {
    heading.textContent = hasReference
      ? 'Your build matches the reference — no differences found.'
      : 'No obvious mistakes were found. Upload an instruction page reference for a sharper comparison.';
  } else if (issues.length) {
    heading.innerHTML = `We found <b>${issues.length} issue${issues.length === 1 ? '' : 's'}</b> in your build photo.`;
  } else {
    heading.textContent = 'No issues to show.';
  }

  if (aligned) {
    heading.innerHTML += ' <span class="align-note">Reference photo auto-aligned and color-corrected for a fairer comparison.</span>';
  } else if (hasReference && alignReason) {
    heading.innerHTML += ` <span class="align-note">${escapeHtml(alignReason)}</span>`;
  }
  if (verified && issues.length) {
    heading.innerHTML += ' <span class="align-note">Each issue was double-checked on a zoomed close-up.</span>';
  }

  mapCount.innerHTML = issues.length ? `<i></i> ${issues.length} issue${issues.length === 1 ? '' : 's'} marked` : 'No issues marked';
  mapImage.innerHTML = uploadedImage
    ? `<img class="map-photo" src="${uploadedImage}" alt="Your uploaded LEGO build">${issues.map((issue, index) => `<button class="pin ${index === 0 ? 'active-pin' : ''}" data-pin="${issue.number}" style="left:${issue.x}%;top:${issue.y}%">${issue.number}</button>`).join('')}`
    : '';

  const refUrl = hasReference ? (alignedReference || referenceImage) : '';
  const compareStrip = refUrl
    ? '<div class="compare"><figure><canvas class="crop"></canvas><figcaption>Your build</figcaption></figure><figure><canvas class="crop"></canvas><figcaption>Should look like</figcaption></figure></div>'
    : '<div class="compare"><figure><canvas class="crop"></canvas><figcaption>Look here</figcaption></figure></div>';
  list.innerHTML = issues.map((issue, index) => `<article class="issue ${index === 0 ? 'active' : ''}" data-pin="${issue.number}"><div class="issue-number">${issue.number}</div><div><span class="severity ${severityClass(issue.type)}">${issue.type}</span><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.detail)}</p>${compareStrip}<div class="fix-visual"><span class="mini-brick ${issue.color || 'grey'}"></span><span>${escapeHtml(issue.action || 'Fix this')} <b>→</b></span></div></div><button class="chevron">⌄</button></article>`).join('');

  renderIssueCrops(issues, refUrl);
  bindResultInteractions();
}

// Draw a zoomed crop of each issue's location — from the build photo, and
// (when a reference exists) the same region of the reference. If the server
// aligned the reference onto the build photo's perspective, the two crops
// line up brick-for-brick; otherwise the reference crop is approximate.
async function renderIssueCrops(issues, refUrl) {
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
      if (canvases[1] && refImg) drawCrop(canvases[1], refImg, issue.x, issue.y, false);
    });
  } catch {
    // Crops are a bonus — if an image fails to decode, the cards still work.
  }
}

function drawCrop(canvas, img, xPct, yPct, markSpot) {
  const size = 150;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const side = Math.min(img.naturalWidth, img.naturalHeight) * 0.32;
  const sx = Math.max(0, Math.min(img.naturalWidth - side, img.naturalWidth * xPct / 100 - side / 2));
  const sy = Math.max(0, Math.min(img.naturalHeight - side, img.naturalHeight * yPct / 100 - side / 2));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
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
  document.querySelectorAll('.pin').forEach(item => {
    item.classList.toggle('active-pin', item.dataset.pin === pin);
    item.style.transform = item.dataset.pin === pin ? 'scale(1.24)' : '';
  });
}
document.querySelector('#new-scan').addEventListener('click', () => { results.classList.add('hidden'); document.querySelector('#workspace').scrollIntoView({ behavior: 'smooth' }); });
document.querySelector('#check-again').addEventListener('click', () => analyze.click());
