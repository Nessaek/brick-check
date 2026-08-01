# BrickCheck

BrickCheck is a small web app that helps you spot mistakes in a LEGO build. Upload a photo of your current build, optionally add a reference image or instruction page, and the app compares them to surface missing pieces, wrong orientations, misplaced bricks, and incorrect parts—with clear fix instructions.

## How it works

1. **Upload your build** — Drop or browse for a photo of your LEGO model (JPG, PNG, or HEIC).
2. **Add a reference (optional)** — Upload a target image or instruction page so the analysis can compare your build against the intended result.
3. **Analyze** — The server sends your photos to Anthropic's Claude vision model and returns a structured list of issues.
4. **Review fixes** — Each issue includes a type, title, detail, and suggested action. Click markers or issue cards to explore what to change.

Without an API key, analysis cannot run — the app will tell you to configure one in `.env`.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (uses the built-in `fetch`, no extra Node dependencies)
- An [Anthropic API key](https://console.anthropic.com/) (**required** for real analysis)
- *(Optional, recommended)* Python 3 with OpenCV + scikit-image, for photo auto-alignment — see [Photo alignment](#photo-alignment) below

## Quick start

```bash
# Clone the repo and enter the directory
cd brickcheck

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Live analysis

Copy the example env file and add your Anthropic API key:

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=...
npm start
```

Or export the key inline before starting:

```bash
export ANTHROPIC_API_KEY="..."
npm start
```

You can also change the port (default `3000`):

```bash
PORT=8080 npm start
```

By default the server calls `claude-sonnet-5`. To use a different model (e.g. `claude-opus-5` for tougher comparisons, or `claude-haiku-4-5-20251001` for faster/cheaper checks), set `CLAUDE_MODEL` in your `.env`.

## Photo alignment

A reference photo shot at a different angle or under different lighting than your build photo can trick *any* vision model into flagging color/orientation issues that aren't real — they're just photography differences.

To reduce that, BrickCheck can auto-align and color-correct your reference photo onto your build photo's perspective before either image goes to Claude:

1. It detects the build's rectangular frame/border in both photos (a robust, unique landmark — much more reliable than trying to feature-match on hundreds of near-identical studs).
2. It computes a perspective warp from the reference photo's frame onto the build photo's frame.
3. It histogram-matches color per channel, so warm gallery lighting or a cool studio flash don't get mistaken for wrong-color bricks.

This step is **optional and fails silently**. If Python/OpenCV/scikit-image aren't installed, or if a build's frame/border can't be detected in one of the photos, BrickCheck just uses your original photos — nothing breaks either way. The server logs which mode it's running in on startup:

```
Photo alignment enabled — reference photos will be auto-aligned to the build photo before comparison.
```
or
```
Photo alignment disabled (python3/opencv/scikit-image not found) — install preprocess/requirements.txt to enable it.
```

To enable it, create a project-local virtualenv (the server picks it up automatically):

```bash
python3 -m venv preprocess/.venv
preprocess/.venv/bin/pip install -r preprocess/requirements.txt
```

(If you'd rather use your system Python, `pip install -r preprocess/requirements.txt` works too — the venv is just preferred when present.)

When alignment succeeds, the results screen shows a small note: *"Reference photo auto-aligned and color-corrected for a fairer comparison."*

When OpenCV is available, the server also overlays a labeled coordinate grid on the copy of the build photo sent to Claude (`preprocess/grid.py`) — the model reads pin positions off the grid instead of estimating them, which measurably improves marker placement. The photo shown in the UI stays clean.

Alignment also unlocks a second detection pass: the server pixel-compares the two registered photos (mean color per brick-sized cell, which cancels tiny registration errors), and sends Claude zoomed crop pairs of the strongest difference spots to verify alongside the full photos. This dramatically improves recall for small defects — one wrong brick in a large mosaic is nearly invisible in a full-frame pass but obvious in a zoomed crop pair. Try it with the pair in `test-images/` (a real LEGO mural photo with one digitally removed brick).

**Note:** this currently only helps when your build has a visible rectangular frame/border (e.g. a framed mosaic). Loose builds without a frame will just use the original, unaligned photos.

## Project structure

```
brickcheck/
├── index.html          # App shell and layout
├── app.js               # Upload, drag-and-drop, and results UI
├── styles.css            # Styling
├── server.js             # Static file server + /api/analyze endpoint
├── preprocess/
│   ├── align.py          # Frame-detection alignment + color normalization (optional)
│   └── requirements.txt  # Python deps for align.py
├── .env.example          # Template for your ANTHROPIC_API_KEY
└── package.json
```

## API

### `POST /api/analyze`

Accepts JSON with base64-encoded images:

```json
{
  "image": "data:image/jpeg;base64,...",
  "referenceImage": "data:image/jpeg;base64,..."
}
```

| Field            | Required | Description                                      |
|------------------|----------|--------------------------------------------------|
| `image`          | Yes      | Photo of the user’s current build                |
| `referenceImage` | No       | Target reference or instruction page to compare  |

Under the hood, the server sends both images to Claude in a single message with a `report_build_issues` tool and a strict JSON schema, so the result always comes back well-formed — no free-text parsing needed. Claude is prompted to inspect the photo region by region (a 3×3 sweep, edges and corners included) and write out its reasoning before calling the tool; if it ever answers without calling the tool, the server retries once with the tool call forced.

**Response:**

```json
{
  "issues": [
    {
      "number": 1,
      "type": "MISSING PIECE",
      "title": "Add a 2×2 blue plate",
      "detail": "It goes on top of the rear axle, directly behind the yellow slope.",
      "action": "Place here",
      "color": "blue"
    }
  ],
  "mode": "live",
  "hasReference": true,
  "aligned": true,
  "alignReason": null
}
```

- `mode` is `"live"` when Claude analysis succeeds.
- Issue types: `MISSING PIECE`, `WRONG ORIENTATION`, `WRONG PIECE`, `MISPLACED PIECE`.
- Each issue includes `x` and `y` percentages to mark its location on your photo.
- Up to 8 issues are returned per analysis.
- `aligned` is `true` when the reference photo was successfully auto-aligned/color-corrected before comparison (see [Photo alignment](#photo-alignment)). It's always `false` when no reference photo was provided, alignment tooling isn't installed, or the build's frame couldn't be detected.
- `alignReason` explains why alignment didn't happen (e.g. `"Could not detect the build's frame/border in one of the photos."`). It's `null` when `aligned` is `true` or no reference photo was provided.
- `alignedReference` is the warped, color-corrected reference photo (as a data URL) when `aligned` is `true`, otherwise `null`. It shares the build photo's coordinate system, so the UI can crop matching "yours vs. target" regions around each issue.

## Evaluating detection quality

The repo includes an eval harness that scores the analysis pipeline against photo pairs with known ground truth — run it after changing the prompt, the model, or the alignment/diff code to see whether detection actually got better:

```bash
npm start     # in one terminal
npm run eval  # in another
```

Each case lives in `eval/cases/<name>/` as `build.jpg` + optional `reference.jpg` + `expected.json` listing the known defects (or an empty list for a correct build). A defect counts as caught when a reported issue lands within ±12 percentage points of its true x/y (`EVAL_TOLERANCE` overrides this); a defect may also list alternate acceptable locations as `"alt": [[x, y], ...]` — useful when a defect could fairly be pinned in more than one place (e.g. a detached piece lying next to the build, or the gap it came from). Reported issues matching no known defect count as false positives. The runner prints a per-case breakdown and a scorecard, and exits non-zero if any case fails.

To add a case: photograph a build complete (that's `reference.jpg`), remove or swap one piece and photograph again (`build.jpg`), then record what you changed in `expected.json`. Each case costs one Claude vision call per run, so keep the set curated.

## Tips for better results

- Use bright, even lighting.
- Photograph the build straight-on, not at a steep angle.
- Include a reference or instruction image when possible—Claude compares your build directly against it.
- Keep image uploads under ~10 MB.

## Privacy

Photos are sent to the server only when you click **Analyze my build**. With a configured API key, images are forwarded to Anthropic's API for analysis. They are not stored by this app.

## License

Private project (`package.json` marks the package as `"private": true`).
