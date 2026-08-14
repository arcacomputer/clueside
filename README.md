# Clueside

**The clues stay on your side.** Clueside is a local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. Inference runs in your browser with WebGPU or WASM using two complementary local models (CommunityForensics ViT + a DINOv2 feature probe). Eligible page-image URLs may be fetched for local decoding, but image bytes are never sent to Clueside or an inference backend. The extension never downloads models or inference assets at runtime. Its only outbound request unrelated to page images is an optional once-a-day GitHub version check for the update banner, which sends no image data and fails silently offline.

The product website lives in [`site/`](site/) and deploys independently from the extension. Preview it with `npm run site:serve` and validate it with `npm run site:check`.

**Author:** Luis Felipe Abarca  
**License:** Original project code is MIT. Bundled model and runtime licenses
are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**For contributors:** This repo targets [POIDH Arbitrum bounty 323](https://poidh.xyz/arbitrum/bounty/323). Read [AGENTS.md](AGENTS.md) for strict build, fusion, and submission rules, and [docs/POIDH-323.md](docs/POIDH-323.md) for the verbatim bounty text, Kenny clarifications, and evaluation protocol.

## How to use

1. Pin the toolbar icon (Chrome puzzle, then pin).
2. Reload the tab you are on.
3. Wait for badges on large images (green OK or red AI). Optional: drop a file in the popup to check one image.

**Badge legend:** red **AI** = likely generated; green **OK** = likely a real photo; orange **?** = not sure; gray **skip** = could not read that image. The percentage is p(AI). We label AI at 65% or higher. Analysis stays on this device.

## Install

### GitHub Release zip (recommended)

1. Download the zip from [Releases](https://github.com/arcacomputer/clueside/releases/latest).
2. Extract it.
3. Open `chrome://extensions` (same on Mac, Windows, and Linux), enable **Developer mode**, click **Load unpacked**, and select the extracted folder. `manifest.json` is at the root of that folder.
4. Optional: in the extension's Details page, enable **Allow access to file URLs** if you want badges on `file://` pages (local image galleries). Images there are scored from the rendered pixels; no network is involved either way.

The zip already includes both model weights (CommunityForensics and DINOv2-small + probe). No extra download. Inference uses WebGPU when Chrome exposes an adapter, otherwise WASM. WebGPU is not required.

### From source

Requires Node.js 20.9 or newer.

```bash
npm ci
npm run fetch-model
npm run build
```

Load unpacked from `dist/`.

**Updates (Load unpacked):** Chrome cannot auto-apply updates to unpacked extensions. The popup shows a banner when a newer [GitHub Release](https://github.com/arcacomputer/clueside/releases) is available. Download the latest zip, extract it, and reload the folder in `chrome://extensions`. The background worker checks once per day; opening the popup also refreshes the check. Offline or failed checks are ignored and do not affect inference.

Maintainers cut a release with `git tag v1.0.0 && git push origin v1.0.0`. That tag runs tests, packages the zip, and uploads it to GitHub Releases. This repo is not claimed to be on the Chrome Web Store.

## Usage

- Large page images (96px or wider/taller) get overlay badges after local analysis. Badges are `position:fixed` and follow the image on scroll. The extension never wraps or replaces `<img>` or `<picture>`.
- Toolbar popup: auto-scan, raw threshold (default 65%), drop a file.
- Badges: red = AI at threshold, orange = uncertain (45-65% raw), green = below that band. Pending `...` stays while the image waits its turn (two at a time). A fetch that fails after it starts becomes `skip`. Inference failure becomes `error`. Success is AI or OK. The first scan of an image-heavy page can take tens of seconds on CPU (WASM). Fetch uses an 8s clock that starts when that image's download starts, not when the badge is painted.

## How scoring works

Two independent neural heads cover complementary failure modes, plus deterministic metadata:

1. **CommunityForensics head:** ViT-Small official FP32 ONNX (CLIP 384). `p(AI) = sigmoid(logit)`. Near-zero false positives on real photos, but under-scores several modern generators (Flux, GPT-4o-image, photoreal DALL-E 3).
2. **DINOv2 probe head:** frozen DINOv2-small backbone (224 center view) with a transparent logistic head over CLS+mean-pooled features (`models/probe/dino-probe.json`: plain standardize/weights/bias, no lookup tables). Trained on ~9.6k images from public datasets across Flux, SD3.5, SDXL-era, Midjourney, DALL-E 3, GPT-4o-image and diverse real photos, with web-realistic JPEG/resize augmentation. This head carries the modern generators.
3. **Neural fusion:** CF-primary with a `0.40` CF floor. When CommunityForensics is confident (`>= 0.65` AI or `< 0.40` real), its score wins. Between `0.40` and `0.65`, DINO can lift (`max(cf, dino)`), so saturated DINO on stock photos (~0-37% CF) cannot override a low CF. On flat graphics and catalog art (low palette / high flat-run pixels), a graphic gate suppresses DINO lift when CF stays below `0.65`, so icons and UI shots do not mass-label AI 100%. CF-confident AI illustrations (`>= 0.65`) are unchanged. Displayed confidence is this raw fused probability; the AI verdict stays at raw `>= 0.65` with no remapping and no logit bias.
4. **Adaptive TTA:** the DINO pass and the official 440 center crop always run. Extra CommunityForensics views (440 corners + 512 center) run only when a head is at least mildly suspicious (CF center or DINO in `[0.15, 0.65)`), so confident reals cost two passes total. `Math.max` of sigmoids, early exit at `>= 0.9`. Under heavy queue load (more than 12 pending) CF drops to center-only; the DINO pass still runs.
5. **Metadata:** C2PA, EXIF/XMP/IPTC, generator text in PNG/JPEG, weak URL hints. Strong metadata forces 0.95-0.99; a URL hint alone cannot cross 65%.

## Tests

```bash
npm test
```

Eval harness: `npm run eval -- ./path/to/labeled-folder` after `npm run fetch-model`. See `eval/README.md`. Public fixtures are not private-benchmark claims.

## Local benchmark

893 images from public datasets, disjoint from probe training rows: 409 AI (DALL-E 3, Flux 1.1, GPT-4o image, Midjourney MJHQ, ELSA_D3 SD-era) and 484 real (COCO, Flickr30k, ImageNet-style, CelebA faces, Food101). Decision rule: raw fused score `>= 0.65`. Built and scored with the `eval/` tooling in this repo (`fetch-bench`, `sweep`, `analyze`).

| Pipeline @ raw 0.65 | BA | TPR | TNR |
|---|---:|---:|---:|
| CommunityForensics adaptive max diagnostic | 71.9% | 44.0% | 99.8% |
| DINOv2 probe only | 93.0% | 89.7% | 96.3% |
| Legacy raw max ensemble (not shipped) | 96.1% | 96.1% | 96.1% |
| PR #26 experiment: CF floor 0.15 + center/max averaging (not shipped) | 79.8% | 59.9% | 99.8% |

The legacy raw max result is included to make the tradeoff visible, not as a product claim. It caused unacceptable false positives on live stock and catalog images, so production keeps the CF guard. The current CF floor 0.40 + flat-graphic-gate policy has not yet been rerun on this exact 893-image fixture; no older or experimental result is presented as its score.

## Limitations

- Local-bench numbers are not a claim about any private benchmark; distribution shift is real.
- Modern photoreal generators remain difficult, especially GPT-4o image. Product and dramatic-lighting photos can still false-positive, so live-site checks remain required before any bounty claim.
- Tiny thumbnails (below 96px) are skipped. Images whose bytes cannot be fetched are scored from the already-decoded pixels on the page when the canvas is readable; otherwise they show `skip`.
- Camera Make/Model in EXIF is not proof of a real photo.
- On CPU/WASM, the first scan of a page with dozens of photos can take tens of seconds (less with multithreaded WASM, which Chrome enables when the extension pages are cross-origin isolated). Badges stay on `...` until that image is fetched and scored. They are not marked Timed out for waiting in the queue.

## Privacy

See [PRIVACY.md](PRIVACY.md) and [docs/privacy.html](docs/privacy.html). Images are decoded and analyzed locally. Nothing is uploaded.

## Model credit

- [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT). Use official FP32 `onnx/model.onnx`, not onnx-community auto-converted q8.
- [Xenova/dinov2-small](https://huggingface.co/Xenova/dinov2-small): ONNX conversion of Meta AI's [DINOv2](https://github.com/facebookresearch/dinov2) (Apache-2.0). The logistic probe head on top is trained in this repo (`eval/fetch-train.mjs`, `eval/extract-features.mjs`, `eval/train-probe.mjs`) and ships as `models/probe/dino-probe.json` (MIT).

## Reproducing the probe head

```bash
node eval/fetch-train.mjs /tmp/train      # ~9.6k images from public HF datasets
node eval/extract-features.mjs /tmp/train models/Xenova/dinov2-small/onnx/model.onnx /tmp/feat-train --augment
node eval/train-probe.mjs /tmp/feat-train models/probe/dino-probe.json
```

The head is a linear probe (768 weights + bias + feature mean/std) over frozen DINOv2 features; the JSON is human-auditable. No benchmark images, hashes, or lookup tables are involved.
