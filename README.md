# Clueside

**The clues stay on your side.** Clueside is a local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. Inference runs in your browser with WebGPU or WASM using two complementary local models (CommunityForensics ViT + a DINOv2 feature probe). Eligible page-image URLs may be fetched for local decoding, but image bytes are never sent to Clueside or an inference backend. The extension never downloads models or inference assets at runtime. Its only outbound request unrelated to page images is an optional once-a-day GitHub version check for the update banner, which sends no image data and fails silently offline.

The Astro product website lives in [`site/`](site/) and deploys independently to Cloudflare Workers Static Assets. Install its isolated dependencies with `npm ci --prefix site`, start it with `npm run site:dev`, and validate the production build with `npm run site:check`.

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
2. **DINOv2 probe head:** frozen DINOv2-small backbone (224 center view) with a transparent logistic head over CLS+mean-pooled features (`models/probe/dino-probe.json`: plain standardize/weights/bias, no lookup tables). Trained on ~11.7k images from public datasets across Flux, SD3.5, SDXL-era, Midjourney, DALL-E 3, GPT-4o-image and diverse real photos, including ~1.9k hard-negative reals (stock photography, product catalogs, interiors, high-saturation nature) plus 118 verified-real live-CDN and 198 product-CDN images that teach the head not to fire on professional real photos, with web-realistic JPEG/resize augmentation. Features are extracted through the same Pillow-exact resize the extension ships, so training matches serving exactly. This head carries the modern generators.
3. **Neural fusion:** CF-primary with three rescue tiers. When CommunityForensics is confident AI (`>= 0.65` after view agreement), its score wins. Between `0.02` and `0.20`, DINO can only rescue if it is highly confident (`p(AI) >= 0.96`); between `0.20` and `0.65`, DINO can lift at `p(AI) >= 0.70`. Below the `0.02` floor a rescue additionally requires CF to be at least faintly awake (`>= 0.0005`) and DINO to be saturated (`>= 0.995`): CF emits hard zeros on real photos it is certain about, while AI images in its blind spots still elicit a faint response, so a flatlined CF is itself evidence of a real photo and is never overridden. On flat graphics and catalog art (low palette / high flat-run pixels), a graphic gate suppresses every DINO rescue tier when CF stays below `0.65`. Displayed confidence is this raw fused probability; the AI verdict stays at raw `>= 0.65` with no remapping and no logit bias. The rescue bands were re-derived under four guards at once: the public bench, a 240-image full-resolution stock and catalog stress set, a held-out live-CDN guard of camera-EXIF-verified editorial photos, and a held-out product-CDN guard of IKEA and Amazon imagery.
4. **Adaptive TTA with view agreement:** the DINO pass and the official 440 center crop always run. Extra CommunityForensics views (440 corners + 512 center) run when a head is at least mildly suspicious (CF center in `[0.15, 0.85)` or DINO `>= 0.15`), so confident reals cost two passes total. Aggregation is the max of sigmoids with one honesty rule: a lone view in `[0.65, 0.85)` does not carry an AI verdict by itself and falls back to the runner-up view, because live CDN-processed real photos can spike a single crop. Any view at `>= 0.85` keeps single-view authority and early-exits. Under heavy queue load (more than 12 pending) CF drops to center-only; the DINO pass still runs.
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
| CommunityForensics center crop only | 66.4% | 32.8% | 100% |
| CommunityForensics adaptive max diagnostic | 73.4% | 47.2% | 99.6% |
| Legacy raw max ensemble (not shipped) | 96.1% | 96.1% | 96.1% |
| Prior policy, prior Node resize (historical) | 85.0% | 70.4% | 99.6% |
| v1.1.0 policy and probe, Pillow-exact preprocess | 87.7% | 75.8% | 99.6% |
| v1.2.0: hard-negative probe, re-derived bands | 90.5% | 81.2% | 99.8% |
| Production: live-guarded policy with view agreement | 87.9% | 76.0% | 99.8% |

The legacy raw max result is included to make the tradeoff visible, not as a product claim. It caused unacceptable false positives on live stock and catalog images, so production keeps the CF guard. The historical 85.0% row was measured through a Node resize the extension never ran; later rows are computed by the same Pillow-exact resize the extension ships, byte for byte. On a 240-image full-resolution stock, catalog, and product photo stress set the production policy shows 3 false positives, zero attributable to a DINO rescue. On a held-out live-CDN guard of 132 camera-EXIF-verified Unsplash editorial variants it shows 4 false positives (3.0 percent), where the v1.2.0 configuration measured 9.2 percent on identical bytes. On a held-out product-CDN guard of 100 IKEA and Amazon images it shows 3 false positives (3.0 percent), two of them CF-driven. Public fixtures are directional only and are not a claim about Kenny's private held-out set.

**Live-web evaluation (published openly):** our 2026-08-16 live-site smoke test of v1.2.0 FAILED on CDN-processed professional photography, and the full findings, isolation experiments, and fixes are in [docs/live-smoke-2026-08-16.md](docs/live-smoke-2026-08-16.md). Three smoke rounds measured 24.3 percent flags on assumed-real pages (v1.2.0), 9.0 percent confirmed-real false positives (v1.3.0, concentrated in product imagery), and 3.21 percent (v1.3.1, clean-profile rerun). The fixes behind that arc: the view-agreement rule, live-CDN and product-CDN hard negatives in the probe, and two new permanent guard sets. v1.3.2 adds a WebGPU watchdog with automatic WASM fallback after the final rerun exposed a worker stall under GPU contention; scoring is unchanged. Live counterexamples are welcome as issues.

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
node eval/fetch-train.mjs /tmp/train      # ~11.7k images from public HF datasets (incl. hard-negative reals)
node eval/extract-features.mjs /tmp/train models/Xenova/dinov2-small/onnx/model.onnx /tmp/feat-train --augment
node eval/train-probe.mjs /tmp/feat-train models/probe/dino-probe.json
```

The head is a linear probe (768 weights + bias + feature mean/std) over frozen DINOv2 features; the JSON is human-auditable. No benchmark images, hashes, or lookup tables are involved. Fetching pulls live public datasets, so counts can drift by a few images between runs; an authenticated Hugging Face token (`HF_TOKEN` or the CLI cache) raises the datasets-server rate limit and is picked up automatically.
