# BrickCheck

Upload a photo of a part-built LEGO model and a photo of how it should look. BrickCheck compares them with Claude's vision API and marks what's wrong: missing pieces, wrong pieces, wrong colours, wrong orientation, pieces in the wrong place.

Both photos are required. The whole method is a comparison, so there's nothing useful to do with only one.

## Running it

Needs Node 18+ and an [Anthropic API key](https://console.anthropic.com/). Python 3 with OpenCV is technically optional but see [Image processing](#image-processing) — the app is much worse without it.

```bash
cp .env.example .env      # then add your ANTHROPIC_API_KEY
```

```bash
npm start
```

Open http://localhost:3000. Analysis takes 20–60 seconds and costs roughly $0.02 per run.

There are no npm dependencies and no build step. `PORT` and `CLAUDE_MODEL` can be set in `.env`; the active model is printed at startup.

## How it works

A single "here are two photos, what's different?" API call doesn't work well. Tested against a mosaic photo with one brick removed, it found nothing — the defect was about 4% of the frame, and a vision model spreads its attention over the whole image. Most of the pipeline exists to concentrate attention on the parts that matter.

**Alignment.** `preprocess/align.py` warps the reference onto the build's viewpoint and histogram-matches the colour. Without this, a photo taken in warm light reads as wrong-coloured bricks. It tries two routes: the build's rectangular frame, which is exact where it exists, then SIFT feature matching for free-standing models that have no frame at all. Frame detection alone engaged on 2 of 9 eval cases — both synthetic — so alignment was off for every real photo. Every homography is validated for plausibility and then correlated against the build; anything below 0.45 is rejected, because a wrong alignment is worse than none. One photo aligned to a granite worktop's speckle instead of the model and scored 0.27.

**Difference detection.** Once the photos are registered, the two are diffed by mean colour per brick-sized cell. Per-pixel diffing doesn't work — a pixel or two of residual alignment error puts ghosting on every stud edge, which drowns out the real defect. Averaging over a cell cancels that. The strongest candidates go to Claude as zoomed crop pairs.

**Coordinate grid.** `preprocess/grid.py` overlays a labelled percentage grid on the copy of the photo sent to Claude, so it reads coordinates off gridlines instead of estimating them. Before this, pins landed 20+ points from the defect. The photo shown in the UI stays clean.

**The request.** Results come back through a `report_build_issues` tool schema rather than as prose. The tool call isn't forced: forcing it skips the reasoning pass where the model examines the image, which measurably hurts detection. If the model answers without calling the tool, the server retries with it forced.

**Verification.** Each reported issue gets a second call. `preprocess/crop.py` cuts a zoomed close-up of the claimed spot, and Claude decides whether it's a real defect or something explained by camera angle, lighting, or a posable part. Rejection needs a concrete reason and uncertainty defaults to keeping the issue, which protects recall. On the suite as it stood this cut false positives from about 2 per run to under 1.

Each stage stayed because the [eval suite](#evaluating-detection-quality) showed it helped. Several plausible ideas were measured and dropped.

## Image processing

Alignment, the coordinate grid and verification all depend on Python and OpenCV, and all three are gated on one check at startup (`python3 -c "import cv2, numpy"`). If it fails you lose all three at once and the app keeps working at noticeably lower accuracy.

```bash
python3 -m venv preprocess/.venv
```

```bash
preprocess/.venv/bin/pip install -r preprocess/requirements.txt
```

The server picks up that virtualenv automatically. System Python works too.

Check the startup log:

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
```

The alternative is `Image processing DISABLED`, which means the Python stack isn't there.

Alignment engages on about half the eval cases: framed mosaics via frame detection, free-standing models via feature matching, and it declines the rest rather than guessing. When it fails the original photos are used and the reason comes back in `alignReason`. The `mosaic-*` fixtures cover the frame path; regenerate them with `preprocess/.venv/bin/python3 eval/make-mosaic-fixtures.py`.

`eval/align_selftest.py` checks this stage without spending anything — it asserts a known missing tile still produces a candidate region, a known-clean pair still produces none, and a known-bad match is still rejected. CI runs it on every push. It exists because the diff threshold was unreachable for a long time and nothing failed; the stage just quietly stopped contributing.

## Layout

```
index.html, app.js, styles.css   Front end. No framework, no build step.
server.js                        Static files, /api/analyze, the pipeline.
preprocess/align.py              Alignment (frame + features), colour match, cell diff.
preprocess/grid.py               Coordinate grid overlay.
preprocess/crop.py               Zoomed crops for verification.
eval/run.js                      Scores the API against known ground truth.
eval/cases/<name>/               build.jpg + reference.jpg + expected.json
Dockerfile                       Node + Python image.
deploy/aws-ec2.md                AWS deployment, by hand.
deploy/terraform/                AWS deployment, as code.
```

## API

`POST /api/analyze` takes both images as base64 data URLs:

```json
{
  "image": "data:image/jpeg;base64,...",
  "referenceImage": "data:image/jpeg;base64,..."
}
```

Both fields are required. The response:

```json
{
  "issues": [
    {
      "number": 1,
      "type": "MISSING PIECE",
      "title": "Add a 2×2 blue plate",
      "detail": "It goes on top of the rear axle, directly behind the yellow slope.",
      "action": "Place here",
      "color": "blue",
      "x": 62,
      "y": 41
    }
  ],
  "mode": "live",
  "aligned": true,
  "alignReason": null,
  "verified": true,
  "rejected": []
}
```

- Issue types are `MISSING PIECE`, `WRONG ORIENTATION`, `WRONG PIECE`, `MISPLACED PIECE`. Up to 8 per analysis.
- `x` and `y` are percentages of the build photo, used to place the markers.
- `aligned` is true when the reference was warped onto the build's viewpoint; `alignReason` says why not when it's false.
- `alignedReference` carries the warped reference as a data URL when aligned, so the UI can crop matching regions.
- `verified` is true when the second-pass check ran. `rejected` lists candidates it discarded and why.

## Deploying

Python and OpenCV need to be present, which rules out serverless runtimes that can't run them. Use a container host or a small VM. The app holds no state, so no volume or database is needed.

```bash
docker build -t brickcheck .
```

```bash
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=choose-one brickcheck
```

The image has been built and run for `linux/amd64` with OpenCV 5.0 working inside it. After deploying, check the log says `Image processing enabled` and `Password protection enabled`. `Image processing DISABLED` means the Python layer didn't build, and the app will answer at reduced accuracy while looking fine.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. Don't bake it into the image. |
| `APP_PASSWORD` | Shared password (HTTP Basic). Unset means no authentication and anyone who can reach the server can spend your API credit. |
| `REBRICKABLE_API_KEY` | Optional. Enables exact brick codes for issues when an instruction page carries a printed set number. Unset, the app links to the set's parts list instead of naming codes. |
| `FEEDBACK_BUCKET` | Optional. S3 bucket for submissions a user reports as wrong. Unset, the report button is hidden and no photos are stored. `FEEDBACK_DIR` is the local-filesystem equivalent for development. |
| `TRUST_PROXY` | Set to `1` only behind a load balancer that sets `X-Forwarded-For`. The Dockerfile defaults it on; unset it if the container is exposed directly, or the rate limit can be spoofed. |
| `HOST` | Bind address, default `0.0.0.0`. Use `127.0.0.1` to keep it off the local network. |
| `PORT`, `CLAUDE_MODEL` | Optional. |

The app doesn't meter or cap spend. Set a spend limit on your Anthropic account instead. Before exposing it to anyone else, set that limit and raise your proxy's request timeout above 60 seconds. `APP_PASSWORD` is the other lever: with it unset the site is open to anyone who finds it, so the account limit is all that bounds the bill. The rate limiter is in-memory, so it resets on restart and is per-instance.

AWS deployments are covered two ways:

- [`deploy/terraform/`](deploy/terraform/) — Terraform/OpenTofu for the whole thing: security group, IAM role, and an instance that builds and runs the app on first boot. Secrets go in SSM rather than through Terraform, so they never land in state.
- [`deploy/aws-ec2.md`](deploy/aws-ec2.md) — the same setup done by hand, if you would rather see each step.

### Running it just for yourself

If it's only for you, don't deploy it. Run it locally and reach it from your phone over Tailscale — nothing is exposed, the key never leaves the machine, and there's no hosting bill.

`com.brickcheck.server.plist` is a macOS LaunchAgent template that keeps the server running across logins. Edit the paths, copy it to `~/Library/LaunchAgents/`, then bootstrap it. It sets `HOST=127.0.0.1` so the app stays on loopback, and reads the API key from `.env` rather than holding it.

```bash
tailscale serve --bg 3000
```

That publishes the loopback port to your own devices over HTTPS. Avoid `tailscale funnel`, which publishes to the internet — at that point `APP_PASSWORD` is no longer optional.

```bash
launchctl kickstart -k gui/$UID/com.brickcheck.server
```

`launchctl print gui/$UID/com.brickcheck.server` shows state, output goes to `server.log`, and `launchctl bootout` stops it.

## Evaluating detection quality

`eval/run.js` scores the pipeline against photo pairs with known answers. Run it after changing the prompt, the model, or the image processing.

```bash
npm start     # one terminal
npm run eval  # another
```

Each case is a directory under `eval/cases/` holding `build.jpg`, `reference.jpg` and an `expected.json` listing the known defects, or an empty list for a correct build. A defect counts as caught when a reported issue lands within ±12 percentage points of its true position. Cases can override that with `"tolerance"`, list alternate acceptable positions with `"alt"` (for a defect that could fairly be pinned in two places, like a detached piece and the gap it came from), and mark known non-defect differences with `"ignore"` so they're neither credited nor penalised.

To add a case, photograph a build complete, remove or swap a piece, photograph it again, and record what changed. Each case costs one or two API calls per run.

### Current results

Nine cases: a generated framed mosaic, two LEGO Botanicals plants, and a pink creature compared against its product photo.

## Learning from real mistakes

There is no fine-tuning. The Claude API has no such endpoint, so the model is
fixed and the only things you can change are the prompt, the pipeline and the
evidence you change them against. That evidence is the eval suite, which makes
a real failure the most valuable thing this app can collect.

Normal analyses store nothing — photos go to a temp directory and are deleted
in a `finally` block. The single exception is the **report a wrong answer**
button, which sends that one submission, with its two photos and the analysis
the user saw, to `FEEDBACK_BUCKET`. It is opt-in, it says plainly what it
sends, and it is hidden entirely when no bucket is configured, so the offer is
never made falsely.

Failures only, not everything. Successes are the overwhelming majority and are
worth nothing here, and logging them would mean holding far more photos of
people's homes for no benefit. Retention is enforced by an S3 lifecycle rule
(90 days by default) rather than by intention.

The instance can `PutObject` and nothing else — no read, no list. A compromised
app can add objects but cannot retrieve what other people reported. Pull one
down with your own credentials and turn it into a case:

```bash
aws s3 sync s3://<bucket>/<id>/ /tmp/<id>/ --region eu-west-2
node eval/promote-feedback.js /tmp/<id> a-short-case-name
```

That writes the photos into `eval/cases/<name>/` with a placeholder
`expected.json`. You then fill in `defects[]` with where the real problem is —
the script deliberately does not copy the reported issues into it, because
those are what the app got *wrong*, and enshrining them as expected would
lock in the bug.

## Instruction pages and brick codes

Uploading an instruction page instead of a photo is optional and changes two things.

The page is read first, for the set number, step number and printed parts callout, and that context is added to the comparison prompt — the callout in particular tells the model which pieces are meant to exist *at this step*, so a piece belonging to a later step is not reported missing.

If `REBRICKABLE_API_KEY` is set and a set number was printed on the page, the set's real inventory is fetched and each missing or wrong piece is matched against it. Two things make that work.

The tool schema's `enum` is built from that inventory, so a part number that is not in your set cannot be returned at all.

And it returns a ranked **shortlist**, not an answer. Forced to name one part it was wrong on 4 of 4 attempts at a missing drum foot, choosing a thin dark-blue plate for a tall pale-blue brick. Asked for up to three candidates it included the right part on 3 of 4 and ranked it first every time. Committing is the hard part; ranking is not — so the UI shows the candidates as thumbnails and you pick, which takes about a second. Passing the build photo into this pass was tried and measured worse (2 of 4, the failures being empty answers), so it stays text-only.

Element IDs (part + colour) are shown where available, since that is what LEGO's own replacement-parts service takes; design IDs otherwise. One part number can appear in several colours in the same set, and each is a different element ID, so the colours are offered as separate candidates.

What it will not do is guess a set number from a photo of the model. Measured on this repo's own images, that returned `unknown` on three of three attempts for one photo and two *different* wrong set numbers for another, both at medium confidence — and one of those wrong numbers is a real set, so checking that the number resolves would not have caught it. A printed number is read; an unprinted one is left alone.

Across five runs of identical code the suite scored anywhere from 4/9 to 7/9 cases, 4–8 defects caught, and 2–3 false positives. **A single run tells you very little** — the 4/9 and a 7/9 were consecutive runs with no changes between them. Judge changes on two or three runs, and treat one case flipping as noise until it repeats.

The most persistent failure is a correct build photographed from two angles, where parts that are simply out of frame get reported as missing.

When the verification pass discards a candidate, the runner says so, because a first-pass miss and a wrongly-rejected candidate need opposite fixes:

```
MISSED  yellow plates removed from pot front
        ^ found by the first pass, then rejected on verification:
          "The marked spot shows only the background floral rug pattern, not a leaf piece at all."
```

The harness has paid for itself. It rejected a stricter prompt rule that sounded right but suppressed a real defect, rejected an image-based few-shot example that taught the model to excuse the defects it should catch, showed Haiku 4.5 to be clearly weaker here than Sonnet, and disproved a "blurry photos beat sharp ones" theory that two runs had seemed to support.

## Photo tips

Bright even lighting, straight-on rather than at a steep angle, and keep uploads under about 10 MB. Photos are re-encoded and downscaled in the browser before upload.

## Privacy

Photos are sent to the server only when you click Analyze, and forwarded to Anthropic's API. This app doesn't store them.

## Licence

No licence is specified, so all rights are reserved by default: readable, but not licensed for reuse. (`package.json` sets `"private": true`, which only prevents npm publication and says nothing about the repository.)

The `eval/cases/mosaic-*` fixtures are generated by `eval/make-mosaic-fixtures.py` and carry no third-party rights. The photographed cases are of the author's own builds.
