# BrickCheck

BrickCheck is a small web app that helps you spot mistakes in a LEGO build. Upload a photo of your current build, optionally add a reference image or instruction page, and the app compares them to surface missing pieces, wrong orientations, misplaced bricks, and incorrect parts—with clear fix instructions.

## Using it

1. **Upload your build** — Drop or browse for a photo of your LEGO model (JPG, PNG, or HEIC).
2. **Add a reference (optional)** — Upload a photo of the finished model, an instruction page, or box art, so the analysis has something to compare against.
3. **Analyze** — Takes roughly 20–40 seconds.
4. **Review fixes** — You get your photo with numbered pins on the problem spots, and a card per issue: what's wrong, what to do, and a zoomed close-up of that spot beside the same region of the reference.

Without an API key, analysis cannot run — the app will tell you to configure one in `.env`.

## How it finds mistakes

The obvious implementation is a single API call: *here are two photos, what's different?* That is what this app did originally, and it fails in a specific way. A real LEGO mural photo with one brick digitally removed came back with **zero issues found** — the defect was about 4% of the frame in a mosaic of thousands of studs.

The reason is attention budget. A vision model spreads a fixed amount of visual attention over whatever you hand it, so a defect occupying 2% of the frame gets roughly 2% of the attention. Everything below is a way to concentrate attention where it matters. Each stage was kept only because [the eval suite](#evaluating-detection-quality) showed it helped, and several plausible-sounding ideas were measured and thrown away.

**1. Make the two photos comparable.** Two photos of the same build differ in angle, distance and lighting — a "wrong colour" is often just warm afternoon light. When you supply a reference, `preprocess/align.py` finds the build's rectangular frame in both photos, computes a perspective warp of the reference onto your build's viewpoint, and histogram-matches the colour. This needs a detectable frame, so in practice it serves flat mosaics; loose 3D builds skip it and the app says so rather than pretending.

**2. Compute where the differences are.** Once the photos are registered you can diff them numerically — but per-pixel diffing fails completely, because even 1–2 pixels of residual alignment error puts bright ghosting along every stud edge that a real missing brick drowns in. What works is comparing **mean colour per brick-sized cell**: averaging cancels the edge ghosting while a missing or swapped brick shifts its cell's colour dramatically. The strongest candidates are sent to Claude as zoomed before/after crop pairs alongside the full photos.

**3. Make the coordinates trustworthy.** Vision models find defects more reliably than they localise them; pins were landing 20+ points from the true spot, correctly reporting "missing foot" and then marking the table below it. So `preprocess/grid.py` overlays a labelled coordinate grid on the copy sent to Claude, which then *reads* percentages off gridlines instead of estimating them. The photo shown in the UI stays clean.

**4. Ask, leaving room to think.** The request uses a tool schema (`report_build_issues`) so results come back as structured data rather than prose to parse. The tool call is deliberately **not** forced: forcing it means the model's first output must be the filled-in form, cutting out the reasoning pass where it actually examines the image, which measurably hurts detection. If it ever answers without calling the tool, the server retries with the call forced, so structure is still guaranteed.

**5. Double-check every claim.** The first pass is open-ended search across a whole scene, which errs in both directions. So each reported issue gets a second call: `preprocess/crop.py` cuts a zoomed close-up centred on the claimed spot (ring-marked, plus the matching reference region), and Claude judges that one claim — real defect, or explained by camera angle, lighting, or a posable part sitting differently? Rejection requires a concrete explanation and uncertainty defaults to keeping the issue, so recall is protected. This cut false positives from 2.0 to 0.7 per run on the suite as it stood. It is the same principle as stage 2: judging one claim against focused evidence is far easier than searching a whole photo.

Every Python stage degrades to a no-op rather than failing, so a machine without OpenCV still returns answers — just markedly worse ones. That is convenient and dangerous, which is why the startup log states plainly which mode it is in.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (uses the built-in `fetch`, no extra Node dependencies)
- An [Anthropic API key](https://console.anthropic.com/) (**required** for real analysis)
- Python 3 with OpenCV + scikit-image — nominally optional, but it powers alignment, pin accuracy and issue verification, so the app is substantially worse without it. See [Image processing setup](#image-processing-setup)

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

By default the server calls `claude-sonnet-5`. To use a different model (e.g. `claude-opus-5` for tougher comparisons, or `claude-haiku-4-5-20251001` for faster/cheaper checks), set `CLAUDE_MODEL` in your `.env`. The active model is printed at startup.

Measured on the eval suite (2 runs each), Haiku 4.5 is meaningfully weaker at this task than the Sonnet default — it caught 2.5/4 defects per run vs 3.7/4, ran 2 false positives per run vs 0.7, and placed pins 13–16 points off the mark where Sonnet manages 0–8. It is roughly 40% faster per analysis, so it's a reasonable choice only if latency matters far more than accuracy.

## Image processing setup

Stages 1, 2, 3 and 5 above all run in Python via OpenCV, and they are gated on a **single** check at startup (`python3 -c "import cv2, numpy"`). Without it you lose alignment, the coordinate grid *and* issue verification at once — the app keeps answering, at roughly the accuracy it had before any of them existed. Treat this as required, not optional.

Create a project-local virtualenv; the server picks it up automatically:

```bash
python3 -m venv preprocess/.venv
```

```bash
preprocess/.venv/bin/pip install -r preprocess/requirements.txt
```

(System Python works too — `pip install -r preprocess/requirements.txt`. The venv is simply preferred when present.)

Check the startup log to confirm which mode you are in:

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
```
or
```
Image processing DISABLED (python3/opencv/scikit-image not found) — alignment, the coordinate grid and issue verification are all off, which markedly reduces accuracy.
```

**On alignment specifically:** it needs a visible rectangular frame or border, so it helps framed mosaics and skips loose 3D builds. When it succeeds the results screen notes *"Reference photo auto-aligned and color-corrected for a fairer comparison"*, and the pixel-diff candidate pass (stage 2) becomes available. When it fails — no frame found, photos too dissimilar, tooling missing — the original photos are used and the reason is reported in `alignReason`. The `mosaic-*` eval cases exercise this path; regenerate their fixtures with `preprocess/.venv/bin/python3 eval/make-mosaic-fixtures.py`.

## Project structure

```
brickcheck/
├── index.html                # App shell and layout
├── app.js                    # Upload, client-side downscaling, results UI
├── styles.css                # Styling
├── server.js                 # Static files, /api/analyze, the analysis pipeline
├── preprocess/
│   ├── align.py              # Frame alignment, colour match, cell-diff candidates
│   ├── grid.py               # Coordinate grid overlay (pin accuracy)
│   ├── crop.py               # Zoomed crops for second-pass verification
│   └── requirements.txt      # Python dependencies
├── eval/
│   ├── run.js                # Scores the live API against known ground truth
│   ├── make-mosaic-fixtures.py  # Regenerates the synthetic mosaic fixtures
│   ├── cases/<name>/         # build.jpg + reference.jpg + expected.json
│   └── images/               # Scratch space for unsorted photos (git-ignored)
├── Dockerfile                # Node + Python image for container hosting
├── com.brickcheck.server.plist  # macOS LaunchAgent template (edit the paths)
├── .env.example              # Template for your ANTHROPIC_API_KEY
└── package.json
```

The front end has no framework and no build step, and the server has no npm dependencies — `npm start` runs it directly.

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
- `aligned` is `true` when the reference photo was successfully auto-aligned/color-corrected before comparison (see [Image processing setup](#image-processing-setup)). It's always `false` when no reference photo was provided, alignment tooling isn't installed, or the build's frame couldn't be detected.
- `alignReason` explains why alignment didn't happen (e.g. `"Could not detect the build's frame/border in one of the photos."`). It's `null` when `aligned` is `true` or no reference photo was provided.
- `alignedReference` is the warped, color-corrected reference photo (as a data URL) when `aligned` is `true`, otherwise `null`. It shares the build photo's coordinate system, so the UI can crop matching "yours vs. target" regions around each issue.

## Deploying

The one thing to get right: **Python and OpenCV are not optional in practice.** Photo alignment, the coordinate grid that makes issue pins accurate, and the zoomed second-pass verification that filters false positives are all gated on them. Deploy somewhere without Python and the app still starts and still answers — just measurably worse. The startup log tells you which mode you are in, so read it after the first deploy.

That rules out plain serverless functions that cannot run the Python stack. Use a container host or a small VM. The app holds **no state**, so no volume or database is needed.

```bash
docker build -t brickcheck .
```

```bash
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=choose-one brickcheck
```

The image has been built and run for `linux/amd64` and verified end to end: OpenCV 5.0 works inside it, `align.py`, `grid.py` and `crop.py` all execute, and the password gate returns 401 without credentials and 200 with.

Read the startup log after the first deploy — this is the check worth not skipping:

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
Password protection enabled (APP_PASSWORD).
```

`Image processing DISABLED` means the Python layer did not build, and the app will keep answering at roughly its original accuracy while looking healthy.

Runtime environment variables:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. Never bake it into the image. |
| `APP_PASSWORD` | Shared password (HTTP Basic). Unset means **no authentication at all** — every visitor can spend your API credit. |
| `TRUST_PROXY` | Set to `1` only when a load balancer sets `X-Forwarded-For`. The Dockerfile defaults it on; unset it if the container is exposed directly, or the rate limit becomes trivially spoofable. |
| `HOST` | Bind address (default `0.0.0.0`). Set `127.0.0.1` to keep it off the local network. |
| `PORT`, `CLAUDE_MODEL` | Optional. |

**On cost:** the app does not meter or cap spend. Set a spend limit on your Anthropic account — that is authoritative and cannot be exceeded by a bug here. For scale, one measured analysis of a mosaic with a reference photo cost about **$0.02**, across two Claude calls (the first pass plus the zoomed verification).

Before exposing it to anyone else: set `APP_PASSWORD`, set that account spend limit, and raise your proxy's request timeout above 60 seconds. The rate limiter is in-memory, so it resets on restart and is per-instance.

A worked AWS deployment is in [`deploy/aws-ec2.md`](deploy/aws-ec2.md).

### Personal setup (no hosting)

If it is only ever for you, do not deploy it at all — run it on your own machine and reach it from your phone over Tailscale. Nothing is exposed to the internet, the API key never leaves the machine, and there is no bill.

`com.brickcheck.server.plist` (a user LaunchAgent in `~/Library/LaunchAgents`) keeps the server running across logins. It sets `HOST=127.0.0.1`, so the app listens on loopback only and joining an untrusted network does not hand it to everyone there. `ANTHROPIC_API_KEY` is read from `.env`, so no secrets live in the plist.

Install Tailscale on the Mac and your phone, sign both into the same tailnet, then publish the loopback port to your own devices:

```bash
tailscale serve --bg 3000
```

That gives an HTTPS URL on your tailnet (`https://<machine>.<tailnet>.ts.net`) reachable from your phone, with no port forwarding and no certificate warnings. `tailscale serve status` shows it; `tailscale serve --https=443 off` withdraws it.

Managing the service:

```bash
launchctl kickstart -k gui/$UID/com.brickcheck.server
```

`launchctl print gui/$UID/com.brickcheck.server` shows its state, output goes to `server.log`, and `launchctl bootout gui/$UID/com.brickcheck.server` stops it. Note `tailscale funnel` is the one thing to avoid here: it publishes to the whole internet, at which point `APP_PASSWORD` stops being optional.

## Evaluating detection quality

The repo includes an eval harness that scores the analysis pipeline against photo pairs with known ground truth — run it after changing the prompt, the model, or the alignment/diff code to see whether detection actually got better:

```bash
npm start     # in one terminal
npm run eval  # in another
```

Each case lives in `eval/cases/<name>/` as `build.jpg` + optional `reference.jpg` + `expected.json` listing the known defects (or an empty list for a correct build). A defect counts as caught when a reported issue lands within ±12 percentage points of its true x/y (`EVAL_TOLERANCE` overrides this, and a case can set its own `"tolerance"`); a defect may also list alternate acceptable locations as `"alt": [[x, y], ...]` — useful when a defect could fairly be pinned in more than one place (e.g. a detached piece lying next to the build, or the gap it came from). Reported issues matching no known defect count as false positives.

A case can also declare `"ignore": [{ "x": .., "y": .., "label": ".." }]` for places where the reference and the build legitimately differ without it being a build mistake — an official product photo showing an accessory the builder never had, for instance. Issues reported there are neither credited nor penalised. The runner prints a per-case breakdown and a scorecard, and exits non-zero if any case fails.

To add a case: photograph a build complete (that's `reference.jpg`), remove or swap one piece and photograph again (`build.jpg`), then record what you changed in `expected.json`. Each case costs one to two Claude vision calls per run, so keep the set curated.

### Where it currently stands

Nine cases: a synthetic framed mosaic (generated, so the suite carries no third-party image licensing), two LEGO Botanicals pot buddies, and a pink creature compared against its official product shot. Across five unchanged runs of the same configuration the suite has landed anywhere from **4/9 to 7/9 cases, 4–8 defects caught, and 2–3 false positives**. The most persistent failure is known: on a correct build photographed from two angles, parts that are simply out of frame get reported as missing.

**That spread is the single most important thing to know before using this harness.** A single run tells you very little — a 4/9 and a 7/9 came from consecutive runs with identical code. Judge any change on the aggregate of at least two or three runs, and treat one case flipping as noise until it repeats.

When the verification pass discards a candidate, the runner attributes the miss rather than leaving it ambiguous:

```
MISSED  yellow plates removed from pot front
        ^ found by the first pass, then rejected on verification:
          "The marked spot shows only the background floral rug pattern, not a leaf piece at all."
```

That distinction matters because the two causes need opposite fixes — a first-pass miss calls for better detection, while a wrongly-rejected candidate calls for a gentler verifier or better coordinates.

The harness has repeatedly earned its cost: it rejected a stricter prompt rule that *sounded* right but suppressed a real defect, rejected an image-based few-shot example that taught the model to excuse the very defects it should catch, showed Haiku 4.5 to be meaningfully weaker here than the Sonnet default, and disproved a "blurry photos beat sharp ones" theory that two runs had appeared to support.

## Tips for better results

- Use bright, even lighting.
- Photograph the build straight-on, not at a steep angle.
- Include a reference or instruction image when possible—Claude compares your build directly against it.
- Keep image uploads under ~10 MB.

## Privacy

Photos are sent to the server only when you click **Analyze my build**. With a configured API key, images are forwarded to Anthropic's API for analysis. They are not stored by this app.

## License

No licence is specified, so all rights are reserved by default — the code is readable but not licensed for reuse. (`package.json` sets `"private": true`, which only prevents accidental npm publication; it says nothing about the repository.)

The eval fixtures under `eval/cases/mosaic-*` are generated by `eval/make-mosaic-fixtures.py`, so they carry no third-party rights. The photographed cases are of the author's own builds.
