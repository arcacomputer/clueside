# Live-web smoke test, 2026-08-16: FAIL, findings, and open work

This document publishes the full results of our pre-claim live-site smoke test of Clueside v1.2.0, the follow-up experiments that isolate the cause, and the work now in progress. We publish failures as openly as successes: the point of this project is a tool that actually works on the real web, and these findings are how it gets there. Contributions welcome, see the end.

## Verdict

**FAIL.** On pages we treated as known-real photography, 266 of 1,093 scanned images (24.3 percent) were labeled AI, against our bar of roughly 1 in 30. Including uncertain badges the rate was 31.6 percent. Everything else passed: offline scoring, overlay tracking, layouts, extension consoles, and AI-site recall (65.9 percent on an AI stock site).

The public 893-image benchmark numbers for v1.2.0 (90.5 percent balanced accuracy, 99.8 percent real-photo pass at raw 0.65) remain true as measured and are reproducible with `eval/`. The failure is a gap between that benchmark distribution and what the live web actually serves. No bounty claim will be made until this is fixed and a re-run smoke passes.

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

## How to help

- Reproduce any number here: `npm ci && npm run fetch-model`, then `npm run eval -- <dir>` on any labeled folder of images. The harness matches the extension byte for byte.
- Live-web counterexamples are the most valuable thing you can contribute: pages where real photos flag or AI images pass, ideally with the exact image URLs. Open an issue with them.
- Recipes for labeled, redistributable live-CDN image corpora (real photography served through imgix, Cloudinary, or similar chains) would directly improve the guard sets.

All numbers in this document come from runs on 2026-08-16 against v1.2.0. Nothing here is a claim about POIDH's private evaluation set.
