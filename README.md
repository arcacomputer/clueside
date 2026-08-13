# Hybrid AI Image Detector

Local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. All inference runs in your browser with WebGPU or WASM. Images never leave your device.

**Author:** Luis Felipe Abarca  
**License:** MIT

## Features

- Auto-scans images on ordinary webpages with overlay badges
- Neural classifier: `buildborderless/CommunityForensics-DeepfakeDet-ViT` (MIT, FP32 ONNX, ~83MB)
- CLIP preprocessing: resize shortest edge 440, center-crop 384, CLIP mean/std
- Raw neural score: `sigmoid(single logit)` as p(AI); threshold 65% with no remapping
- Deterministic signals: C2PA `digitalSourceType`, EXIF/XMP/IPTC, PNG/JPEG embedded text, weak URL hints
- Popup file drop for local images
- Fully offline after one-time model setup

## Install (unpacked)

1. Build the extension (see below).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/` folder.

## Build

```bash
npm ci
npm run fetch-model
npm run build
```

- `fetch-model` downloads `onnx/model.onnx` (FP32) and preprocessor config into `models/` at build time.
- `build` bundles JavaScript, copies WASM into `lib/`, copies models, and writes `dist/`.

On first run, if `models/` is missing from the packed extension, the offscreen worker can download weights once into Cache Storage, then stays offline.

## Usage

- Browse any page: large images (96px or wider/taller) get a badge after analysis.
- Open the toolbar popup to toggle auto-scan, adjust the raw threshold slider (default 65%), or drop a file.
- Badge colors: red = AI at threshold, orange = uncertain (45-65% raw), green = below uncertain band, grey = skipped or unreadable.

## How scoring works

1. **Neural:** CommunityForensics ViT-Small ONNX. Input is CLIP-normalized 384x384 crop. `p(AI) = sigmoid(logit)`. The old 5-class `ai-source-detector` head was a dead end at fixed 0.65 (near-uniform softmax).
2. **Metadata:** C2PA trained/composite algorithmic media, EXIF Software/CreatorTool/DigitalSourceType, A1111/ComfyUI PNG text, JPEG comments.
3. **URL hints:** Weak +0.05 max, capped so they never push a sub-threshold neural score over 65% alone.
4. **Fusion:** Strong metadata forces 0.95-0.99. Otherwise neural score plus weak bonuses. Eval is binary at raw >= 0.65.

## Tests

```bash
npm test
```

## Evaluation harness

See `eval/README.md` and run `npm run eval -- ./path/to/labeled-folder` after `npm run fetch-model`. The harness is the product path (`clip-preprocess.js` + onnxruntime-web). On the public n=19 fixture at raw 0.65 it measured **88.89% BA** (7/9 AI, 10/10 real). That fixture is not the private bounty benchmark.

## Limitations

- New or fine-tuned generators may score incorrectly until the model is retrained.
- Photoreal DALL-E 3 images can still score below threshold on a small public n=19 fixture (`pluto` 0.136, `crying-robot` 0.236 at raw 0.65 in the eval harness). This is not proof of 75% on the private bounty benchmark.
- Preprocessing in production matches `src/clip-preprocess.js` (canvas in the extension, RawImage resize in the Node harness), not a live Hugging Face `AutoProcessor` call. Resize interpolation can differ slightly from upstream PIL bicubic; scores may differ from a standalone `transformers` notebook on the same file (for example `mars` scored 0.539 in an experiment but 0.878 in the harness).
- Stripped metadata removes deterministic signals; neural-only mode is weaker.
- Cross-origin `blob:`/`data:` URLs and CORS-blocked CDNs may show a grey badge with no score.
- Small thumbnails, icons, and decorative images are skipped.
- Camera Make/Model in EXIF is not proof of a real photo.
- Frequency residual and URL hints are weak signals only.
- C2PA: the extension uses `@contentauth/c2pa-web` (local WASM) in the offscreen document when available, with a byte-scan fallback. The Node eval harness uses the fallback only. Malformed or partial manifests may be missed by the fallback.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: images are decoded and analyzed locally. Nothing is uploaded.

## Model credit

- ONNX weights: [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT). Use the FP32 `onnx/model.onnx` export, not the onnx-community auto-converted q8 builds.
