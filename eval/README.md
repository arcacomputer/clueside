# Evaluation harness

Dev-only Node scorer. Uses the same CommunityForensics ONNX model, CLIP preprocessing (`src/clip-preprocess.js`), heuristics, and fusion as the extension. This is the product path: `clip-preprocess.js` + onnxruntime-web.

## Prerequisites

```bash
npm ci
npm run fetch-model
```

Weights must exist at `models/buildborderless/CommunityForensics-DeepfakeDet-ViT/onnx/model.onnx` (FP32).

## Folder layout

```
my-dataset/
  real/
    photo-001.jpg
  ai/
    gen-001.png
```

Supported AI folder names: `ai`, `fake`, `generated`, `synthetic`  
Supported real folder names: `real`, `authentic`, `photo`, `natural`

## Run

```bash
npm run eval -- ./my-dataset
npm run eval -- ./my-dataset --tta=center
npm run eval -- ./my-dataset --tta=always
```

Output:

1. CSV lines per image: `file,label,raw_score,neural_score,verdict,predicted_ai,extra_ran,early_exit,views,reasons`
2. Summary with TPR, TNR, and balanced accuracy at raw `0.65` when both `ai/` and `real/` folders are present

## Scoring details

- Neural: `p(AI) = sigmoid(logit)` from CommunityForensics ViT (CLIP 384 crop, official FP32 ONNX)
- Preprocess: resize shortest edge 440, 384 center + corners, plus a 512 center crop, CLIP mean/std (values from upstream `preprocessor_config.json`). Crops are taken on the resized full image, not on an already-cropped 384 square.
- TTA (default `--tta=adaptive`): extra crops run only when the official 440 center p(AI) is in `[0.15, 0.65)`. Aggregation is `Math.max` of raw sigmoids. Inference stops if any crop is `>= 0.9`.
- Probe modes: `--tta=center` (official center only) and `--tta=always` (max of all six views, for TNR checks)
- Fusion: same `fuseScores()` as production (C2PA byte scan in Node; c2pa-web runs only in the extension offscreen doc)
- Eval decision: binary at raw fused score >= 0.65 (no UI remapping)
- URL hints cannot cross the threshold alone

## Preprocessing vs Hugging Face AutoProcessor

The extension and harness do **not** call `AutoImageProcessor` at runtime. Both use `src/clip-preprocess.js`:

| Step | Extension (offscreen) | Harness (Node) | HF `AutoProcessor` |
|------|----------------------|----------------|--------------------|
| Decode | `createImageBitmap` | `RawImage.read` | PIL / torchvision |
| Resize shortest edge 440 (and 512 for the extra TTA center) | canvas `drawImage` | `RawImage.resize` | PIL bicubic (`resample=3`) |
| Crop 384 (center, then corners; not a second resize of a 384 square) | canvas crop blit | `RawImage.crop` inclusive max | center crop |
| Normalize | CLIP mean/std in CHW | same | same |

The logical pipeline matches `preprocessor_config.json`, but resize interpolation is not guaranteed to be identical to PIL bicubic. Per-image scores can differ from a standalone `transformers` notebook on the same file. **Report harness numbers** when describing this repo; do not copy scores from external AutoProcessor experiments.

## Fixture observation (n=19 public set, not a bounty claim)

The n=19 maintainer gallery is not in git. Re-run locally with `npm run eval -- /path/to/fixture` (adaptive is the default). Prior center-only harness numbers at raw 0.65:

| Metric | Center-only harness |
|--------|---------------------|
| AI recall (TPR) | 7/9 (77.8%) |
| Real recall (TNR) | 10/10 (100%) |
| Balanced accuracy | 88.89% |

Selected AI scores (neural, center-only harness path):

| Image | Score | @ 0.65 |
|-------|-------|--------|
| mars | 0.878 | hit |
| pluto | 0.136 | miss |
| crying-robot | 0.236 | miss |

Chrome gallery (same 19, center crop, raw 0.65): reals OK in the 0-25% band; seven AIs at 82-100%; photoreal DALL-E 3 misses `pluto` ~4% and `crying-robot` ~20%. Adaptive TTA skips extras when center is below 0.15 (`pluto`), and runs extras for `crying-robot`. Max of sigmoids is not a score stretch: 0.20 stays 0.20 unless another crop actually scores higher.

`mars` scored 0.539 in a separate AutoProcessor experiment but 0.878 here, which illustrates the preprocessing path difference above. `n=19` is a small public fixture, not proof of 75% on the private bounty benchmark.

If `--tta=always` ever flags one of the 10 real fixture photos at 0.65, keep `--tta=adaptive` (the production default). Do not ship Six-Fingers logit bias, int8/q4 as the primary head, or a 0.5-to-0.65 remap.

### Prior heads on the same fixture (for context)

| Head | AI recall | Real recall | BA @ 0.65 |
|------|-----------|-------------|-----------|
| 5-class `ai-source-detector` (`1-p(real)`) | 8/9 | 3/10 | 59.44% |
| `max(AI head)` (PR #2) | 0/9 | 10/10 | 50.00% |
| distilled binary (PR #3) | 0/9 | 10/10 | 50.00% |
| CommunityForensics harness (this repo) | 7/9 | 10/10 | 88.89% |

## Bounty alignment

- No hardcoded image hashes
- Raw 0.65 threshold, no score remapping
- URL hints cannot cross threshold alone
