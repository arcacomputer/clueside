# Hybrid AI Image Detector

Local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. Inference runs in your browser with WebGPU or WASM using two complementary local models (CommunityForensics ViT + a DINOv2 feature probe). Images never leave your device; the extension never downloads models or inference assets at runtime. The only network call the installed extension makes is an optional once-a-day GitHub version check for the update banner, which sends no image data and fails silently offline.

**Author:** Luis Felipe Abarca  
**License:** MIT

## Install

### GitHub Release zip (recommended)

1. Download the zip from [Releases](https://github.com/felirami/hybrid-ai-image-detector/releases/latest).
2. Extract it.
3. Open `chrome://extensions` (same on Mac, Windows, and Linux), enable **Developer mode**, click **Load unpacked**, and select the extracted folder. `manifest.json` is at the root of that folder.
4. Optional: in the extension's Details page, enable **Allow access to file URLs** if you want badges on `file://` pages (local image galleries). Images there are scored from the rendered pixels; no network is involved either way.

The zip already includes both model weights (CommunityForensics and DINOv2-small + probe). No extra download. Inference uses WebGPU when Chrome exposes an adapter, otherwise WASM. WebGPU is not required.

### From source

```bash
npm ci
npm run fetch-model
npm run build
```

Load unpacked from `dist/`.

**Updates (Load unpacked):** Chrome cannot auto-apply updates to unpacked extensions. The popup shows a banner when a newer [GitHub Release](https://github.com/felirami/hybrid-ai-image-detector/releases) is available. Download the latest zip, extract it, and reload the folder in `chrome://extensions`. The background worker checks once per day; opening the popup also refreshes the check. Offline or failed checks are ignored and do not affect inference.

Maintainers cut a release with `git tag v1.0.0 && git push origin v1.0.0`. That tag runs tests, packages the zip, and uploads it to GitHub Releases. This repo is not claimed to be on the Chrome Web Store.

## Usage

- Large page images (96px or wider/taller) get overlay badges after local analysis. Badges are `position:fixed` and follow the image on scroll. The extension never wraps or replaces `<img>` or `<picture>`.
- Toolbar popup: auto-scan, raw threshold (default 65%), drop a file.
- Badges: red = AI at threshold, orange = uncertain (45-65% raw), green = below that band. Pending `...` stays while the image waits its turn (two at a time). A fetch that fails after it starts becomes `skip`. Inference failure becomes `error`. Success is AI or OK. The first scan of an image-heavy page can take tens of seconds on CPU (WASM). Fetch uses an 8s clock that starts when that image's download starts, not when the badge is painted.

## How scoring works

Two independent neural heads cover complementary failure modes, plus deterministic metadata:

1. **CommunityForensics head:** ViT-Small official FP32 ONNX (CLIP 384). `p(AI) = sigmoid(logit)`. Near-zero false positives on real photos, but under-scores several modern generators (Flux, GPT-4o-image, photoreal DALL-E 3).
2. **DINOv2 probe head:** frozen DINOv2-small backbone (224 center view) with a transparent logistic head over CLS+mean-pooled features (`models/probe/dino-probe.json`: plain standardize/weights/bias, no lookup tables). Trained on ~9.6k images from public datasets across Flux, SD3.5, SDXL-era, Midjourney, DALL-E 3, GPT-4o-image and diverse real photos, with web-realistic JPEG/resize augmentation. This head carries the modern generators.
3. **Neural fusion:** `max(cf, dino)`, meaning "either detector fired". Displayed confidence is this raw fused probability; the AI verdict stays at raw `>= 0.65` with no remapping and no logit bias.
4. **Adaptive TTA:** the DINO pass and the official 440 center crop always run. Extra CommunityForensics views (440 corners + 512 center) run only when a head is at least mildly suspicious (CF center or DINO in `[0.15, 0.65)`), so confident reals cost two passes total. `Math.max` of sigmoids, early exit at `>= 0.9`. Under heavy queue load (more than 12 pending) CF drops to center-only; the DINO pass still runs.
5. **Metadata:** C2PA, EXIF/XMP/IPTC, generator text in PNG/JPEG, weak URL hints. Strong metadata forces 0.95-0.99; a URL hint alone cannot cross 65%.

## Tests

```bash
npm test
```

Eval harness: `npm run eval -- ./path/to/labeled-folder` after `npm run fetch-model`. See `eval/README.md`. Public n=19 fixture numbers are not a private-benchmark claim.

## Local benchmark

893 images from public datasets, disjoint from probe training rows: 409 AI (DALL-E 3, Flux 1.1, GPT-4o image, Midjourney MJHQ, ELSA_D3 SD-era) and 484 real (COCO, Flickr30k, ImageNet-style, CelebA faces, Food101). "Web-stress" re-encodes every image at max 800px JPEG q78. Decision rule: raw fused score `>= 0.65`. Built and scored with the `eval/` tooling in this repo (`fetch-bench`, `sweep`, `analyze`).

| Pipeline @ raw 0.65 | Clean BA | Clean TPR/TNR | Web-stress BA | Web-stress TPR/TNR |
|---|---|---|---|---|
| CommunityForensics only (old production) | 71.9% | 44.0 / 99.8 | 74.0% | 48.7 / 99.4 |
| DINOv2 probe only | 93.0% | 89.7 / 96.3 | 93.3% | 89.5 / 97.1 |
| **Ensemble (shipped policy)** | **96.1%** | 96.1 / 96.1 | **96.1%** | 95.6 / 96.7 |

Per-source correctness for the shipped policy on the clean bench: DALL-E 3 97%, Flux 1.1 97%, GPT-4o 95%, Midjourney 100%, SD/ELSA 91%; CelebA 100%, COCO 96%, Flickr 97%, Food101 100%, ImageNet-style 90%. The raw 0.65 operating point is within noise of this bench's optimum (0.67), so the threshold is honest, not tuned.

## Limitations

- Local-bench numbers are not a claim about any private benchmark; distribution shift is real.
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
