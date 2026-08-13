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
```

Output:

1. CSV lines per image: `file,label,raw_score,neural_score,verdict,predicted_ai,reasons`
2. Summary with TPR, TNR, and balanced accuracy at raw `0.65` when both `ai/` and `real/` folders are present

## Scoring details

- Neural: `p(AI) = sigmoid(logit)` from CommunityForensics ViT (CLIP 384 crop, FP32 ONNX)
- Preprocess: resize shortest edge 440, center-crop 384, CLIP mean/std (values from upstream `preprocessor_config.json`)
- Fusion: same `fuseScores()` as production (C2PA byte scan in Node; c2pa-web runs only in the extension offscreen doc)
- Eval decision: binary at raw fused score >= 0.65 (no UI remapping)
- URL hints cannot cross the threshold alone

## Preprocessing vs Hugging Face AutoProcessor

The extension and harness do **not** call `AutoImageProcessor` at runtime. Both use `src/clip-preprocess.js`:

| Step | Extension (offscreen) | Harness (Node) | HF `AutoProcessor` |
|------|----------------------|----------------|--------------------|
| Decode | `createImageBitmap` | `RawImage.read` | PIL / torchvision |
| Resize shortest edge 440 | canvas `drawImage` | `RawImage.resize` | PIL bicubic (`resample=3`) |
| Center crop 384 | canvas crop blit | `RawImage.center_crop` | center crop |
| Normalize | CLIP mean/std in CHW | same | same |

The logical pipeline matches `preprocessor_config.json`, but resize interpolation is not guaranteed to be identical to PIL bicubic. Per-image scores can differ from a standalone `transformers` notebook on the same file. **Report harness numbers** when describing this repo; do not copy scores from external AutoProcessor experiments.

## Fixture observation (n=19 public set, not a bounty claim)

Re-run on the maintainer-local 19-image folder at raw 0.65 (`npm run eval -- /path/to/fixture`):

| Metric | Harness result |
|--------|----------------|
| AI recall (TPR) | 7/9 (77.8%) |
| Real recall (TNR) | 10/10 (100%) |
| Balanced accuracy | 88.89% |

Selected AI scores (neural, harness path):

| Image | Score | @ 0.65 |
|-------|-------|--------|
| mars | 0.878 | hit |
| pluto | 0.136 | miss |
| crying-robot | 0.236 | miss |

`mars` scored 0.539 in a separate AutoProcessor experiment but 0.878 here, which illustrates the preprocessing path difference above. `n=19` is a small public fixture, not proof of 75% on the private bounty benchmark.

Chrome gallery (same 19 images, after a reload, raw 0.65): reals OK in the 0-25% band; seven AIs at 82-100%; still miss photoreal DALL-E 3 (`pluto` ~4-14%, `crying-robot` ~20%). No ensemble or score stretch was added: earlier 5-class and distilled heads dropped real-photo TNR. The competitive advantage versus LocalLens on this fixture is 10/10 real recall, so the neural head stays CommunityForensics FP32 sigmoid.

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
