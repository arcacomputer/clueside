# Hybrid AI Image Detector

Local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. Inference runs in your browser with WebGPU or WASM. Images never leave your device.

**Author:** Luis Felipe Abarca  
**License:** MIT

## Install

### GitHub Release zip (recommended)

1. Download the zip from [Releases](https://github.com/felirami/hybrid-ai-image-detector/releases/latest).
2. Extract it.
3. Open `chrome://extensions` (same on Mac, Windows, and Linux), enable **Developer mode**, click **Load unpacked**, and select the extracted folder. `manifest.json` is at the root of that folder.

The zip already includes CommunityForensics ONNX weights. No extra download. Inference uses WebGPU when Chrome exposes an adapter, otherwise WASM. WebGPU is not required.

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

1. **Neural:** CommunityForensics ViT-Small official FP32 ONNX (CLIP 384). `p(AI) = sigmoid(logit)`. Default threshold is raw 65% with no remapping.
2. **Adaptive TTA:** score the official shortest-edge 440 center crop first. Extra views (440 corners plus a 512 center crop) run only when that center p(AI) is in `[0.15, 0.65)` and few images are waiting. If more than four images are still pending, only the center crop runs so a masonry page does not starve WASM. Take `Math.max` of those sigmoids. Stop early if any crop is `>= 0.9`. No 0.5-to-0.65 remap and no logit bias.
3. **Metadata:** C2PA, EXIF/XMP/IPTC, generator text in PNG/JPEG, weak URL hints. A URL hint alone cannot cross 65%.
4. **Fusion:** Strong metadata forces 0.95-0.99. Otherwise neural score plus weak bonuses.

## Tests

```bash
npm test
```

Eval harness: `npm run eval -- ./path/to/labeled-folder` after `npm run fetch-model`. See `eval/README.md`. Public n=19 fixture numbers are not a private-benchmark claim.

## Limitations

- Photoreal DALL-E 3 can still score below 65%. On the Wikimedia copies of the named fixture gens, `crying-robot` center 0.236 is in the TTA band and extra crops reach 0.985; `pluto` center 0.137 stays a miss (other crops were lower). Confident-real centers below 0.15 skip extra crops. CommunityForensics FP32 stays the head. Not 75% on the private POIDH benchmark.
- CORS-blocked images, tiny thumbnails, and new generators with stripped metadata are weaker or skipped.
- Camera Make/Model in EXIF is not proof of a real photo.
- On CPU/WASM, the first scan of a page with dozens of photos can take tens of seconds. Badges stay on `...` until that image is fetched and scored. They are not marked Timed out for waiting in the queue.

## Privacy

See [PRIVACY.md](PRIVACY.md) and [docs/privacy.html](docs/privacy.html). Images are decoded and analyzed locally. Nothing is uploaded.

## Model credit

[buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT). Use official FP32 `onnx/model.onnx`, not onnx-community auto-converted q8.
