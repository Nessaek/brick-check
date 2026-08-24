# BrickSolver

Take a photo of a half-built LEGO model, add a photo of how it's meant to look, and BrickSolver marks up what's wrong: missing pieces, wrong pieces, wrong colours, things facing the wrong way, things in the wrong place.

You need both photos. It works by comparing them, so one on its own is no use.

Live at **https://bricksolver.com**.

## Why I built it

I love LEGO and I make mistakes constantly. A plate goes on one stud over, or I grab the wrong grey, and I don't find out until forty steps later when a section won't close up. By then, finding the error means taking half of it apart. I wanted something that would just tell me.

I assumed the hard part would be the plumbing. Upload two photos, ask a model what's different, draw the answer on screen. It turns out asking that question directly gets you nothing at all. A missing brick is maybe 4% of the frame, and the model's attention is spread over the other 96%. Nearly everything in [How it works](#how-it-works) is there to narrow that attention down, and every stage had to be checked against real cases, because about half the things that seemed obviously correct made it worse.

The bit that genuinely defeated me is occlusion. A LEGO build is a solid object and one photograph only shows you part of it. The model can't tell the difference between a piece that's missing and a piece that's round the back, so it announces missing arms on a model that's simply facing away. I've got an entire paragraph of prompt arguing with it about this, complete with a worked example, and it still gets it wrong in both directions: it invents absences, and the fix for that makes it timid about real ones. No amount of rewording will solve it. You can't recover a 3-D fact from one 2-D view. It needs several photos or an actual 3-D model of the set, and that's what I'd build next.

The other surprise was how misleading this comparison is even to a human eye. I put six of my own builds up against official product renders with one deliberate mistake in each. What leaps out of those pairs is colour: leaves that look mint against sage, branches that look grey against brown. Almost none of it is real, because renders don't reproduce LEGO colours the way a phone camera does. The planted mistakes were missing pieces every single time, and a missing piece is the thing you scroll straight past, because there's nothing there to catch your eye. Absence is much harder to spot than difference, and that seems to be true of people as well as models.

## Running it

You need Node 18+ and an [Anthropic API key](https://console.anthropic.com/). Python with OpenCV is nominally optional, but read [Image processing](#image-processing) first — without it the app is a lot worse.

```bash
cp .env.example .env      # add your ANTHROPIC_API_KEY
```

```bash
npm start
```

Then open http://localhost:3000. A run takes 20–60 seconds and costs about $0.02.

No npm dependencies, no build step. Set `PORT` and `CLAUDE_MODEL` in `.env` if you want; the model in use is printed at startup.

## How it works

The naive version doesn't work. I tried it: one call, two photos, "what's different?", against a mosaic with a brick removed. It found nothing. So most of the pipeline is about pointing the model at a smaller piece of the picture.

**Alignment.** `preprocess/align.py` warps the reference onto the build's viewpoint and matches the colour histogram, so a photo shot under a warm bulb doesn't read as a wall of wrong-coloured bricks. There are two routes. Frame detection looks for the build's rectangular border and is exact when there is one. Failing that, SIFT feature matching handles free-standing models. Frame detection alone worked on 2 of 9 cases, both of them synthetic, which meant alignment was effectively switched off for every real photograph. Each candidate transform gets sanity-checked and then correlated against the build photo, and anything under 0.45 is thrown out, because a confidently wrong alignment is worse than none at all. One attempt locked onto the speckle in a granite worktop instead of the model and scored 0.27.

**Difference detection.** With the photos registered, they're compared by average colour per brick-sized cell. Per-pixel comparison is useless here: a pixel or two of leftover misalignment lights up every stud edge and buries the real defect. Averaging over a cell cancels it out. The strongest candidates get sent to Claude as zoomed before/after crops.

**Coordinate grid.** `preprocess/grid.py` stamps a labelled percentage grid onto the copy of the photo that goes to Claude, so it can read positions off the gridlines rather than guess. Before that, markers were landing 20+ points away from the thing they were describing. The photo you see in the browser stays clean.

**The request.** Answers come back through a `report_build_issues` tool schema instead of prose. I deliberately don't force the tool call. Forcing it skips the reasoning pass where the model actually looks at the image, and detection measurably suffers. If it replies without calling the tool, the server retries with it forced.

**Verification.** Every reported issue gets a second look. `preprocess/crop.py` cuts a close-up of the spot and Claude decides whether it's a genuine defect or something explained by the camera angle, a shadow, or a hinged part that's just posed differently. It has to give a concrete reason to reject, and anything uncertain stays in, which protects recall.

Every one of those earned its place against the [eval suite](#does-it-actually-work). Several other perfectly reasonable ideas didn't and were dropped.

## Image processing

Alignment, the coordinate grid and verification all need Python and OpenCV. All three hang off a single check at startup (`python3 -c "import cv2, numpy"`), so if that fails you lose the lot at once and the app carries on at noticeably worse accuracy.

```bash
python3 -m venv preprocess/.venv
```

```bash
preprocess/.venv/bin/pip install -r preprocess/requirements.txt
```

The server finds that virtualenv on its own. System Python is fine too.

Check the startup log says:

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
```

If it says `Image processing DISABLED`, the Python side isn't there.

Alignment engages on roughly half the eval cases and declines the rest rather than guessing. When it declines, the original photos are used and the reason comes back in `alignReason`. The `mosaic-*` fixtures cover the frame-detection path and can be regenerated with `preprocess/.venv/bin/python3 eval/make-mosaic-fixtures.py`.

There's also `eval/align_selftest.py`, which tests this stage for free. It checks that a known missing tile still produces a candidate region, a known-good pair still produces none, and a known-bad match is still rejected. CI runs it on every push. It exists because the diff threshold was quietly unreachable for months: nothing errored, the stage just stopped contributing anything and no one noticed.

## Layout

```
index.html, app.js, styles.css   Front end. No framework, no build step.
server.js                        Static files, the API, the pipeline.
feedback.js                      Stores reported mistakes in S3.
preprocess/align.py              Alignment, colour match, cell diff.
preprocess/grid.py               Coordinate grid overlay.
preprocess/crop.py               Zoomed crops for verification.
eval/run.js                      Scores the API against known answers.
eval/cases/<name>/               build.jpg + reference.jpg + expected.json
Dockerfile                       Node + Python image.
deploy/terraform/                AWS, as code.
deploy/aws-ec2.md                The same thing by hand.
```

## API

### `POST /api/analyze`

Both images as base64 data URLs:

```json
{
  "image": "data:image/jpeg;base64,...",
  "referenceImage": "data:image/jpeg;base64,...",
  "referenceKind": "photo",
  "setNumber": "10309"
}
```

`image` and `referenceImage` are required. `referenceKind` is `photo` (the default) or `instructions`, which opts into reading the page for a set and step number. `setNumber` is optional and overrides anything read off a page.

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

Issue types are `MISSING PIECE`, `WRONG ORIENTATION`, `WRONG PIECE` and `MISPLACED PIECE`, up to 8 per run. `x` and `y` are percentages of the build photo, which is how the markers get placed. `aligned` says whether the reference was warped onto the build's viewpoint, with `alignReason` explaining a no. `alignedReference` carries the warped version when there is one, so the UI can crop matching regions. `verified` says the second pass ran, and `rejected` lists what it threw out and why.

`set` holds `{number, name, step}` when a set number is known. `partsSource` is `catalogue` when part codes came from the set's real inventory. `feedback` says whether the server can store a reported mistake, which is what decides if the report button appears. Individual issues may carry `parts`, a ranked shortlist of candidate bricks.

### `POST /api/set`

Looks up a set by number and returns its official photo, so there's nothing to upload. Needs `REBRICKABLE_API_KEY`; without it you get a 501.

```json
{ "setNumber": "10309" }
```

```json
{
  "number": "10309",
  "name": "Succulents",
  "year": 2022,
  "parts": 771,
  "image": "data:image/png;base64,..."
}
```

The image is of the finished set, which makes it the wrong reference if you're halfway through. The media type is sniffed from the file's magic bytes rather than taken from the upstream `Content-Type`, which is wrong for some sets. 404 for an unknown set, 502 if the catalogue is down.

### `POST /api/feedback`

Stores one submission that a user reported as wrong. Needs `FEEDBACK_BUCKET` (or `FEEDBACK_DIR` locally), otherwise it returns 501 and the UI hides the button.

```json
{
  "image": "data:image/jpeg;base64,...",
  "referenceImage": "data:image/jpeg;base64,...",
  "note": "it missed the missing foot",
  "analysis": { "issues": [] }
}
```

Returns `{ "ok": true, "id": "..." }`. This is the only endpoint that keeps anyone's photos, and only when they ask it to.

All three share a per-IP rate limit.

## Deploying

Python and OpenCV have to be present, which rules out serverless runtimes that can't run them. A container host or a small VM is fine. The app keeps no state, so there's no volume or database to worry about.

```bash
docker build -t brickcheck .
```

```bash
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=choose-one brickcheck
```

Built and run for `linux/amd64` with OpenCV 5.0 working inside. Afterwards, check the log. `Image processing DISABLED` means the Python layer didn't build and the app will happily answer at reduced accuracy while looking perfectly healthy.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. Don't bake it into the image. |
| `APP_PASSWORD` | Shared password over HTTP Basic. Leave it unset and anyone who finds the URL can spend your API credit. |
| `REBRICKABLE_API_KEY` | Optional. Turns on set lookup and exact brick codes. Without it the app links to the parts list instead of naming codes. |
| `FEEDBACK_BUCKET` | Optional. S3 bucket for reported mistakes. Without it the report button is hidden and nothing is stored. `FEEDBACK_DIR` is the local equivalent. |
| `TRUST_PROXY` | Set to `1` only behind something that sets `X-Forwarded-For`. On by default in the Dockerfile; unset it if the container is directly exposed, or the rate limit can be spoofed. |
| `HOST` | Bind address, default `0.0.0.0`. Use `127.0.0.1` to keep it off the local network. |
| `PORT`, `CLAUDE_MODEL` | Optional. |

The app doesn't meter spend. Put a limit on your Anthropic account, because that's the only thing that actually caps the bill. Raise your proxy's request timeout above 60 seconds too, since analyses regularly run longer than that. The rate limiter lives in memory, so it resets on restart and doesn't coordinate between instances.

For AWS there are two paths: [`deploy/terraform/`](deploy/terraform/) does the whole thing as code, with secrets in SSM so they never touch Terraform state, and [`deploy/aws-ec2.md`](deploy/aws-ec2.md) walks through the same setup by hand if you'd rather see each step.

### Just for yourself

If it's only for you, don't deploy it at all. Run it locally and reach it from your phone over Tailscale. Nothing is exposed, the key never leaves your machine, and there's no bill.

`com.bricksolver.server.plist` is a macOS LaunchAgent template that keeps the server running across logins. Fill in the paths, drop it in `~/Library/LaunchAgents/`, bootstrap it. It pins `HOST=127.0.0.1` and reads the key from `.env`.

```bash
tailscale serve --bg 3000
```

That publishes the loopback port to your own devices over HTTPS. Don't use `tailscale funnel` unless you've set `APP_PASSWORD`, because that publishes to the internet.

```bash
launchctl kickstart -k gui/$UID/com.bricksolver.server
```

`launchctl print gui/$UID/com.bricksolver.server` shows the state, output goes to `server.log`, and `launchctl bootout` stops it.

## Does it actually work

`eval/run.js` scores the pipeline against photo pairs where I know the answer. Worth running after touching the prompt, the model, or the image processing.

```bash
npm start     # one terminal
npm run eval  # another
```

Each case is a folder under `eval/cases/` with `build.jpg`, `reference.jpg` and an `expected.json` listing the defects, or an empty list for a build that's correct. A defect counts as caught if a reported issue lands within ±12 points of where it actually is. Cases can override the tolerance, list alternative acceptable positions with `alt` (for something like a detached leaf, where pointing at the leaf or the gap it left are both fair), and mark known non-defect differences with `ignore` so they're neither rewarded nor punished.

To add one: photograph the finished build, take a piece off, photograph it again, write down what you changed.

### Where it stands

16 cases, 15 labelled defects, 3 correct builds as controls. Seven of them are recent: real builds photographed at home and compared against official product renders, with a genuine mistake planted in each. That combination is both the most realistic and the hardest, and it's new, so expect it to score worse than the older set did.

On the previous nine cases, five runs of identical code scored anywhere from 4/9 to 7/9, and a later three runs went 5, 8, 5. **One run tells you almost nothing.** The 8 and one of the 5s were consecutive with no code change between them. Judge anything on two or three runs, and treat a single case flipping as noise until it repeats.

The suite hasn't been run in full since it doubled in size.

The most stubborn failure is still a correct build shot from two angles, where pieces that are simply out of frame get reported missing.

When the verification pass throws out a candidate, the runner says so, because a first-pass miss and a wrongly-rejected candidate want opposite fixes:

```
MISSED  yellow plates removed from pot front
        ^ found by the first pass, then rejected on verification:
          "The marked spot shows only the background floral rug pattern, not a leaf piece at all."
```

The harness has more than paid for itself. It killed a stricter prompt rule that sounded sensible but suppressed a real defect, killed an image-based few-shot example that taught the model to excuse the very defects it was meant to catch, showed Haiku 4.5 to be clearly weaker here than Sonnet, and disproved a "blurry photos actually do better" theory that two lucky runs had made look real.

## Learning from real mistakes

You can't fine-tune Claude. There's no endpoint for it, so the model is fixed and the only things you can change are the prompt, the pipeline, and the evidence you're changing them against. That evidence is the eval suite, which makes a genuine failure the single most valuable thing this app can collect.

Normal runs store nothing. Photos go to a temp directory and get deleted in a `finally` block. The one exception is the **report a wrong answer** button, which sends that submission — both photos and the analysis the user saw — to `FEEDBACK_BUCKET`. It's opt-in, it spells out what it's sending, and it's hidden entirely when there's no bucket configured, so the offer is never made falsely.

Only failures, never everything. Successes are the overwhelming majority and they're worth nothing here, and hoovering them up would mean holding a lot more photos of people's homes for no benefit. Retention is an S3 lifecycle rule, 90 days by default, so it's enforced rather than merely intended.

The instance can `PutObject` and nothing else. No read, no list. If the app is ever compromised, the attacker can add objects but can't pull back what other people reported. To turn one into a case, fetch it with your own credentials:

```bash
aws s3 sync s3://<bucket>/<id>/ /tmp/<id>/ --region eu-west-2
node eval/promote-feedback.js /tmp/<id> a-short-case-name
```

That drops the photos into `eval/cases/<name>/` with a placeholder `expected.json`. You fill in `defects[]` with where the problem actually is. The script deliberately doesn't copy the reported issues in, because those are what the app got wrong, and writing them in as the expected answer would bake the bug in permanently.

## Set lookup

Type a set number and it fetches that set's official product photo from Rebrickable to use as the reference, so there's nothing to upload. It shows you the name, year, piece count and a thumbnail to confirm before using it.

It fetches the finished set, so it's the wrong reference if you're mid-build: everything you haven't got to yet reads as missing. Uploading an instruction page is still the way to check a single step.

Two things fell out of building this. Rebrickable serves PNG bytes from `.jpg` URLs labelled `Content-Type: image/jpeg`, and different sets genuinely differ, so the type is sniffed from magic bytes instead. The Anthropic API rejects an image whose declared media type doesn't match its content, so trusting the header would have produced intermittent failures that looked like a model problem. And it makes render-against-photo the default comparison, which is the harder one, for the reasons in the section above.

## Instruction pages and brick codes

Uploading an instruction page instead of a photo is optional and does two things.

The page gets read first for the set number, step number and printed parts callout, and that goes into the comparison prompt. The callout is the useful part: it says which pieces belong at *this* step, so something from a later step stops being reported as missing.

With `REBRICKABLE_API_KEY` set and a set number in hand, the set's real inventory is fetched and each missing or wrong piece is matched against it. The tool schema's `enum` is built from that inventory, so a part number that isn't in your set can't be returned at all.

It gives you a ranked shortlist rather than one answer, and that distinction matters more than I expected. Forced to name a single part, it was wrong on 4 out of 4 attempts at a missing drum foot, picking a thin dark-blue plate for a tall pale-blue brick. Asked for up to three candidates, it included the right part 3 times out of 4 and ranked it first every time. Committing is the hard bit; ranking isn't. So the UI shows thumbnails and you pick, which takes about a second. Passing the build photo into that step made it worse, so it stays text-only.

Element IDs are shown where available, since that's what LEGO's replacement-parts service wants, and design IDs otherwise. The same part number can appear in several colours in one set, and each is a different element ID, so those are offered as separate candidates.

What it won't do is guess a set number from a photo of the model. On my own images that returned "unknown" three times out of three for one photo, and two *different* wrong numbers for another, both at medium confidence. One of the wrong numbers was a real set, so checking that the number resolves wouldn't have caught it either. A printed number gets read; an unprinted one gets left alone.

## Photo tips

Bright even light, straight on rather than at a steep angle, under about 10 MB. Photos are re-encoded and downscaled in the browser before upload anyway.

## Privacy

Photos are only sent to the server when you press Analyze, and they're forwarded to Anthropic's API to do the comparison. They're written to a temp directory during processing and deleted immediately afterwards.

The exception is the report button. If you use it, that submission's photos are stored so the mistake can be turned into a test case, and they're deleted after 90 days. Nothing else is kept, and nothing is stored unless you choose to report something.

## Licence

No licence is specified, so all rights are reserved by default: readable, but not licensed for reuse. (`package.json` sets `"private": true`, which only stops npm publication and says nothing about the repository.)

The `eval/cases/mosaic-*` fixtures are generated by `eval/make-mosaic-fixtures.py` and carry no third-party rights. The photographed cases are all of my own builds.
