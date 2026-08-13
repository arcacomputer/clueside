# Hybrid AI Image Detector

Local Manifest V3 Chrome extension that estimates whether images on the web (or files you drop in) were likely created with AI. All inference runs in your browser with WebGPU or WASM. Images never leave your device.

**Author:** Luis Felipe Abarca  
**License:** MIT

## Features

- Auto-scans images on ordinary webpages with overlay badges
- Neural classifier (primary): `onnx-community/ai-image-detect-distilled-ONNX` (MIT, q8, ~15MB binary fake/real)
- Generator hints (optional): `onnx-community/ai-source-detector-ONNX` 5-class head (~83MB)
- Deterministic signals: C2PA `digitalSourceType`, EXIF/XMP/IPTC, PNG/JPEG embedded text, weak URL hints
- Raw fused score with default threshold **65% p(AI)** (no remapping of model 0.5 to UI 65%)
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

- `fetch-model` downloads `onnx/model_quantized.onnx` and config files into `models/` at build time.
- `build` bundles JavaScript, copies WASM into `lib/`, copies models, and writes `dist/`.

On first run, if `models/` is missing from the packed extension, the offscreen worker can download weights once into Cache Storage, then stays offline.

## Usage

- Browse any page: large images (96px or wider/taller) get a badge after analysis.
- Open the toolbar popup to toggle auto-scan, adjust the raw threshold slider (default 65%), or drop a file.
- Badge colors: red = AI at threshold, orange = uncertain (45-65% raw), green = below uncertain band, grey = skipped or unreadable.

## How scoring works

1. **Neural:** binary `p(AI) = p(fake)` from ai-image-detect-distilled (MIT). The 5-class source detector supplies optional generator hints only.
2. **Metadata:** C2PA trained/composite algorithmic media, EXIF Software/CreatorTool/DigitalSourceType, A1111/ComfyUI PNG text, JPEG comments.
3. **URL hints:** Weak +0.05 max, capped so they never push a sub-threshold neural score over 65% alone.
4. **Fusion:** Strong metadata forces 0.95-0.99. Otherwise neural score plus weak bonuses. Eval is binary at raw >= 0.65.

## Tests

```bash
npm test
```

## Evaluation harness

See `eval/README.md`. Run `npm run eval -- ./path/to/labeled-folder --sweep` to compare strategies on your fixture.

## Limitations

- New or fine-tuned generators may score incorrectly until the model is retrained.
- Stripped metadata removes deterministic signals; neural-only mode is weaker.
- Cross-origin `blob:`/`data:` URLs and CORS-blocked CDNs may show a grey badge with no score.
- Small thumbnails, icons, and decorative images are skipped.
- Camera Make/Model in EXIF is not proof of a real photo.
- Frequency residual and URL hints are weak signals only.
- C2PA: the extension uses `@contentauth/c2pa-web` (local WASM) in the offscreen document when available, with a byte-scan fallback. The Node eval harness uses the fallback only. Malformed or partial manifests may be missed by the fallback.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: images are decoded and analyzed locally. Nothing is uploaded.

## Model credit

- ONNX weights: [onnx-community/ai-image-detect-distilled-ONNX](https://huggingface.co/onnx-community/ai-image-detect-distilled-ONNX) (MIT), hints from [onnx-community/ai-source-detector-ONNX](https://huggingface.co/onnx-community/ai-source-detector-ONNX) (Apache-2.0)
