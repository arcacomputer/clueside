# Evaluation harness

Dev-only Node scorer. Uses the same CommunityForensics ONNX model, CLIP preprocessing, heuristics, and fusion as the extension.

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
- Preprocess: resize shortest edge 440, center-crop 384, CLIP mean/std (same as upstream `preprocessor_config.json`)
- Fusion: same `fuseScores()` as production (C2PA byte scan in Node; c2pa-web runs only in the extension offscreen doc)
- Eval decision: binary at raw fused score >= 0.65 (no UI remapping)
- URL hints cannot cross the threshold alone

## Fixture observation (n=19 public set, not a bounty claim)

On a maintainer-local 19-image folder at raw 0.65:

| Metric | Result |
|--------|--------|
| AI recall | 6/9 |
| Real recall | 10/10 |
| Balanced accuracy | 83.33% |

Misses were photoreal DALL-E 3 (`pluto` 0.043, `crying-robot` 0.176, `mars` 0.539). This is a small public fixture, not proof of 75% on the private bounty benchmark.

The previous 5-class `ai-source-detector` head scored ~50% BA on the same fixture under every honest mapping at 0.65. The distilled binary head (`ai-image-detect-distilled`, PR #3) scored 0/9 AI, 10/10 real, 50.00% BA (max score 0.6135).

## Bounty alignment

- No hardcoded image hashes
- Raw 0.65 threshold, no score remapping
- URL hints cannot cross threshold alone
