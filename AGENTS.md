# BrickCheck — working notes for agents

A web app that compares a photo of a part-built LEGO model against a photo of
how it should look, and tells you what's wrong: missing pieces, wrong pieces,
wrong colours, wrong orientation. Upload an instruction page instead of a
finished photo and it also reads the printed set number and lists the exact
bricks to order.

Live at https://13.42.213.246.sslip.io/ — public, no password, deliberately.

## Running it

```bash
npm start                    # server on :3000, reads .env
npm run eval                 # scores eval/cases against a running server
preprocess/.venv/bin/python3 eval/align_selftest.py   # free, no API key, runs in CI
```

`.env` holds `ANTHROPIC_API_KEY` (required) and optionally `REBRICKABLE_API_KEY`,
`APP_PASSWORD`, `CLAUDE_MODEL`, `FEEDBACK_DIR`. It is gitignored and has been
leaked once — CI fails the build if key material appears in the tree.

Python image processing lives in `preprocess/.venv`. Without it the app still
runs, just much worse, and says so at startup. Every startup line reports
which optional features are on; keep that habit when adding one, because the
failure mode here is silence, not errors.

## The shape of it

`server.js` orchestrates, `app.js` + `index.html` + `styles.css` are the front
end, `preprocess/*.py` does the image work, `eval/` is the measurement.

The pipeline exists because a single "what's different between these two
photos?" call finds nothing when the defect is ~4% of the frame. Each stage
narrows attention:

1. **Align** (`preprocess/align.py`) — warp the reference onto the build's
   viewpoint, histogram-match the colour
2. **Diff** — compare mean colour per brick-sized cell, flag candidate regions
3. **Grid** (`preprocess/grid.py`) — overlay a labelled coordinate grid so the
   model *reads* pin positions instead of estimating them
4. **Detect** — one Claude call with the gridded build, the reference, and any
   candidate crops
5. **Verify** (`preprocess/crop.py`) — second pass over zoomed crops to reject
   false positives
6. **Parts** — optional, only with a set number: shortlist bricks from the
   set's real inventory

## Things that were measured, not guessed

Do not "simplify" these away. Each one cost real API spend to establish, and
several are counter-intuitive.

- **The eval scores 5–8/9 on identical code.** Three consecutive runs went 5,
  8, 5. Never conclude anything from one run. This is why the eval is a manual
  workflow and not a CI gate — it would charge you to fail randomly.
- **`tool_choice: auto` beats forcing the tool call.** Forcing skips the
  reasoning pass and measurably hurts detection, especially near photo edges.
- **Diff by cell mean colour, not per pixel.** 1–2px of residual registration
  error puts ghosting on every stud edge and drowns the real defect.
- **Alignment tries the frame first, then SIFT.** Frame detection is better
  where a frame exists (repeated studs mislead feature matching) but only 2 of
  9 eval cases have one — both synthetic. Feature matching covers real photos.
- **A wrong alignment is worse than none.** It manufactures defects and looks
  authoritative. Every homography is checked for plausibility then correlated
  against the build; below 0.45 it is rejected. One photo aligned to a granite
  worktop's speckle at 0.27 and put the model in the wrong corner.
- **Candidate diff regions need a higher bar (0.80) than alignment itself.**
  With bad hints the model reported *nothing* four runs running; with hints
  suppressed it found the defect. Wrong hints anchor the search rather than
  focusing it.
- **For part codes, shortlist — never commit.** Asked to name one part it was
  wrong 4/4; asked to rank three it included the right part 3/4 and ranked it
  first every time. The user picks from thumbnails.
- **Do not pass the build photo into the parts pass.** Tried twice, measured
  worse both times (more empty answers).
- **Never infer a set number from the model in a photo.** It returned
  "unknown" 3/3 on one image and two *different* wrong numbers on another,
  both at medium confidence — and one wrong number is a real set, so checking
  that it resolves does not catch it. Only read numbers printed on a page.
- **There is no fine-tuning for Claude.** Improving accuracy means changing the
  prompt or pipeline and measuring against the eval. That is the whole loop.

Known weakness: on blurry photos the verification pass sometimes rejects a
defect the detector correctly found. The eval reports which stage lost a
defect — trust that attribution, because a first-pass miss and a wrongly
rejected candidate need opposite fixes.

## Constraints that look arbitrary but aren't

- **Zero npm dependencies.** `server.js` uses only Node builtins. This is why
  `feedback.js` signs SigV4 by hand rather than pulling in the AWS SDK. Keep it.
- **New static files need three edits**: `STATIC_FILES` and the `mime` map in
  `server.js`, plus the `COPY` line in the `Dockerfile`. The allowlist is a
  security control — anything not on it 404s, including `.env`.
- **The app stores nothing.** Photos go to a temp dir and are deleted in a
  `finally`. The single exception is a user pressing "report a wrong answer".
  The UI states this; if you change the behaviour, change the copy first.
- **The instance is cattle.** Any `user-data` change replaces it. An Elastic IP
  keeps the URL stable across replacements — before that existed, the address
  moved three times in a day.
- **IMDS hop limit is 2, not the default 1.** The app runs in a container,
  which costs a hop; at 1, credential fetches fail silently and S3 uploads
  break with no obvious cause.
- **Deploy before you apply, not after.** Pushing and then replacing the
  instance makes the deploy target a machine that no longer exists.

## Deployment

OpenTofu in `deploy/terraform` — EC2, Caddy for TLS via sslip.io, secrets in
SSM Parameter Store (never in state), GitHub Actions deploying over OIDC + SSM
Run Command with no long-lived AWS credentials and no inbound SSH.

Pushes to `main` touching app files redeploy automatically. Replacing the
instance changes its ID — re-set the `AWS_INSTANCE_ID` GitHub secret or the
next deploy fails.

The site is public and the app has no spend meter. The limit on the Anthropic
account is the only cost ceiling.

## Working style this repo expects

Measure before claiming. Most of the notes above contradict a plausible-
sounding assumption, and several were found only because a change was tested
rather than reasoned about. Two habits that keep paying:

- When something silently does nothing, suspect a threshold. The diff detector
  was mathematically near-unreachable for the project's whole life and nothing
  ever failed.
- When a stage is optional, log which mode it is in at startup. Every bug in
  this repo's history has been silent rather than loud.
