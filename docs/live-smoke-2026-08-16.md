# Live-web smoke test, 2026-08-16: FAIL, findings, and open work

This document publishes the full results of our pre-claim live-site smoke test of Clueside v1.2.0, the follow-up experiments that isolate the cause, and the work now in progress. We publish failures as openly as successes: the point of this project is a tool that actually works on the real web, and these findings are how it gets there. Contributions welcome, see the end.

## Verdict

**FAIL.** On pages we treated as known-real photography, 266 of 1,093 scanned images (24.3 percent) were labeled AI, against our bar of roughly 1 in 30. Including uncertain badges the rate was 31.6 percent. Everything else passed: offline scoring, overlay tracking, layouts, extension consoles, and AI-site recall (65.9 percent on an AI stock site).

The public 893-image benchmark for v1.2.0 measured 90.5 percent balanced accuracy and a 99.8 percent real-photo pass at raw 0.65; the failure is a gap between that benchmark distribution and what the live web actually serves. (The fixes below deliberately trade bench points for live robustness: the shipped pipeline measures 87.9 percent balanced accuracy on the same fixture, reproducible with `eval/`.) No bounty claim will be made until this is fixed and a re-run smoke passes.

## Protocol

- Release zip v1.2.0, loaded unpacked into Chrome for Testing 152 on a fresh profile, Apple M3 Pro.
- Two full passes: WebGPU backend and forced-WASM backend.
- Sites: Unsplash (home, two photographer profiles, three full-photo pages), IKEA (two category grids), Wikipedia (three photo-heavy articles), AP News, Amazon search results, Wikimedia Commons featured pictures, and Lummi (AI stock, for recall).
- Per page: settle, scroll, settle, then count every badge and capture evidence for every AI or uncertain badge.

## Results by site (both passes combined)

| Site | Scanned | AI flags | Flag rate |
|---|---:|---:|---:|
| Unsplash (6 page types x 2 passes) | 495 | 214 | 43.2% |
| IKEA grids | 88 | 16 | 18.2% |
| Amazon search | 150 | 23 | 15.3% |
| AP News | 34 | 5 | 14.7% |
| Wikimedia Commons featured | 62 | 8 | 12.9% |
| Wikipedia (3 articles x 2 passes) | 264 | 0 | 0.0% |
| Lummi (AI content, recall) | 88 | 58 | 65.9% |

The failure is heavily concentrated on professional and commercial photography served through image CDNs. Wikipedia, which serves plain sRGB JPEG thumbnails of ordinary photography, is completely clean across 264 scans. Both backends produced equivalent results, ruling out a WebGPU or WASM numerics cause.

## Isolation experiments

All experiments run through the Node harness (`eval/harness.mjs`), which computes byte-identical model inputs to the extension.

**1. Format and size are not the cause by themselves.** We re-encoded the same 80 real Unsplash photos from our stress set (2 of 80 flagged as original large JPEGs) into CDN-like variants locally:

| Variant | Flags out of 80 |
|---|---:|
| JPEG 500px q60 | 0 |
| AVIF 500px | 2 |
| AVIF 1080px | 1 |
| WebP 500px q60 | 6 |

WebP costs something, but nothing here approaches the live rates.

**2. Real CDN bytes reproduce the failure, format-independent.** We fetched 10 images from the live Unsplash editorial grid exactly as the browser receives them (`w=700, auto=format, fit=crop, q=60`, which serves AVIF to Chrome) and the same URLs forced to JPEG:

| Delivery | Flags out of 10 |
|---|---:|
| Live grid AVIF | 2 |
| Same URLs as JPEG | 3 |

So the trigger is the live processing chain plus the current content distribution, not the container format, and our harness reproduces it, which means it is fixable and testable offline.

**3. The flags decompose into three distinct causes.**

- **DINO probe saturation on current commercial photography.** Example: a studio product lifestyle shot scored CF 0.003 but DINO 0.9994. Our probe's hard-negative reals came from a circa-2020 Unsplash dataset; the 2026 editorial style (heavy grading, commercial studio work) is a different distribution and the probe saturates beyond any threshold we could set. Fix: retrain the probe with verified-real current-distribution images. In progress.
- **CommunityForensics alone spiking on CDN-processed photos.** Example: a real drone shot of a boat on turquoise water scored CF 0.84 with DINO near zero. Large low-texture fields plus CDN recompression read as generated texture to CF. A candidate mitigation (requiring two TTA views at or above 0.65 before a mid-band CF verdict stands) removes about a third of these at a cost of 1.5 points of benchmark recall; decision pending ground-truthed rates.
- **The known-real assumption is partly wrong.** Unsplash in 2026 hosts AI-generated content in its feed under its labeling policy. Some fraction of the 266 flags may be true positives. We are ground-truthing every flagged class against Unsplash's own AI labels before treating 24.3 percent as the real false-positive rate. Several IKEA and Amazon flags are likely genuine CGI marketing renders, a gray zone we count against ourselves.

## Also found

- The popup performs a GitHub release check even when offline. It is non-blocking and scoring works fully offline, but it will be suppressed when the browser is offline.
- The harness previously could not ingest `.avif` files at all, which is part of how this gap stayed invisible. Fixed.

## Work in progress

1. Harvest a ground-truthed corpus of current Unsplash editorial images with per-photo AI-label status from the public API, in both grid-bytes and JPEG form.
2. Measure the true false-positive rate of v1.2.0 on verified-real live bytes.
3. Split verified reals into probe training hard negatives and a held-out live-stress guard that becomes part of the permanent evaluation gate alongside the existing bench and stress sets.
4. Retrain the probe, re-derive fusion bands under all guards, and decide the two-view CF rule with numbers.
5. Fix the offline update ping.
6. Re-run the full smoke. The bounty claim stays on hold until it passes.

## Update, 2026-08-16 (same day): the fix, measured

The work-in-progress list above is done. Findings and results:

- **Unsplash exposes no AI label anywhere.** We audited the full API surface, page HTML, frontend bundles, tags, and image bytes for 268 current editorial photos: no labeling mechanism exists as served. Ground truth via platform labels is impossible; we fell back to camera EXIF present in the API metadata (184 of 268 photos) as a probable-real prior, and imgix strips all embedded provenance metadata from served bytes, which also means metadata-based detection layers are inert on CDN images.
- **True FP rate of v1.2.0 on probable-real live bytes: 9.2 percent** (17 of 184 camera-EXIF photos, identical in AVIF and JPEG form). The no-EXIF segment flagged at a similar rate, so the smoke's headline 24.3 percent was inflated by page mix and feed rotation, not primarily by hidden AI content.
- **The fix** (three coordinated changes, shipped together): a view-agreement rule (a lone CommunityForensics view in [0.65, 0.85) cannot carry an AI verdict and falls back to the runner-up view; views at or above 0.85 keep single-view authority), the probe retrained with 118 verified-real live CDN images, and the strong rescue tier tightened to [0.02, 0.20) with DINO at or above 0.96.
- **Verified with the implemented pipeline:** public bench 87.9 percent BA, 76.0 TPR, 99.8 TNR; stress set 3 of 240; held-out live-CDN guard 4 of 132 (3.0 percent, versus 9.2 percent for v1.2.0 on identical bytes). The live guard is now a permanent part of the evaluation gate next to the bench and stress sets, and the trade (2.6 bench points for a threefold live FP reduction) is deliberate: false positives on real photos are the failure that matters.
- A full live smoke rerun of the fixed build is the next gate. No claim before it passes.

## Second smoke (v1.3.0): 9.0 percent, and the failure moved to product imagery

The full rerun found 54 confirmed-real false positives out of 603 images (9.0 percent). The Unsplash problem was gone; nearly every remaining flag was IKEA and Amazon product photography, and every one of those was probe-driven (CommunityForensics at 0.004 to 0.11 with the DINO probe at 0.97 or higher). The probe had never seen the product-CDN distribution: studio lighting, seamless backgrounds, CGI-adjacent marketing renders. Under the bounty's criterion this imagery counts as not generative AI, so we count every flag against ourselves.

The fix (v1.3.1): probe retrained with 198 IKEA and Amazon product-CDN negatives, with 100 more held out as a fourth permanent guard in the evaluation gate. Result: the IKEA spot check went from 5 of 12 flagged to 0 of 12, the held-out product guard measures 3 of 100 (two of the three are CF-driven, not probe-driven), and the public bench is byte-identical at 87.9 BA, 76.0 TPR, 99.8 TNR, stress set 3 of 240.

## Third smoke (v1.3.1): the accuracy bar passes, and a reliability bug surfaces

The full smoke on a clean Chromium profile:

- Confirmed-real false positives: 16 of 498, or 3.21 percent. The arc across the three rounds is 24.3 to 9.0 to 3.21 percent.
- AI detection on Lummi's AI-generated feed: 64.29 percent at the raw 0.65 threshold.
- Offline check: scoring fully functional with zero network traffic.
- One reliability defect: with the test machine under active use, the WebGPU inference worker wedged once mid-pass and left 104 badges pending until restart. Accuracy was unaffected; availability was not.

The fix (v1.3.2): a watchdog around every model run with a 20 second wedge timeout, a GPU device-loss listener, and a one-way automatic fallback to the WASM backend with a single in-flight retry, so a wedged or lost GPU device now degrades to slower scoring instead of a stalled page. No scoring code changed, so the benchmark numbers above are re-affirmed unchanged for v1.3.2.

## How to help

- Reproduce any number here: `npm ci && npm run fetch-model`, then `npm run eval -- <dir>` on any labeled folder of images. The harness matches the extension byte for byte.
- Live-web counterexamples are the most valuable thing you can contribute: pages where real photos flag or AI images pass, ideally with the exact image URLs. Open an issue with them.
- Recipes for labeled, redistributable live-CDN image corpora (real photography served through imgix, Cloudinary, or similar chains) would directly improve the guard sets.

All numbers in this document come from runs on 2026-08-16; versions are stated inline (v1.2.0 baseline through the v1.3.2 fix). Nothing here is a claim about POIDH's private evaluation set.

## Update, 2026-08-17: v1.3.2 live Unsplash still fails, and why the 3 percent guard missed it

A later load of the public v1.3.2 release zip (WASM, no WebGPU) on the Unsplash featured feed scored 15 AI, 5 OK, and 6 uncertain out of 26 badges. Ordinary editorial photos (forest, boat on turquoise water, clouds, laptop) displayed AI 81-94 percent, with raw p(AI) equal to the neural score. Wikipedia photos stayed clean. thispersondoesnotexist.com stayed AI 100 percent.

Two production behaviors explain the gap between that feed and the 3.0 percent held-out live-CDN guard:

1. **Center-only load-shed.** `ttaModeForLoad` returned `center` when more than 12 images were pending. A 26-image masonry therefore scored the first ~14 images on the official 440 center crop alone. `agreedMax` never ran (`used.length < 2`). A lone 0.81-0.94 center crop became the verdict. The 132-image guard was scored with the harness default `--tta=adaptive`, so it never saw this path.
2. **Early-exit at 0.85.** Even when adaptive TTA ran, a center crop of 0.85-0.94 stopped extras and kept single-view authority. The isolation boat-on-water example was already CF 0.84; the later featured-feed scores sit in the same band and above it.

v1.3.3 does not remap 0.65. It keeps extras on busy pages (adaptive already skips extras on confident reals) and raises `TTA_EARLY_EXIT` from 0.85 to 0.95 so a lone 0.81-0.94 crop must gather extras and survive agreement. The published 893/240/132/100 fixtures are not in git. `eval/fetch-live-guard.mjs` builds a smaller stand-in; `eval/compare-tta-policy.mjs` compares load-shed, v1.3.2, and production on a sweep. A full live Unsplash re-smoke of v1.3.3 has not been published.
