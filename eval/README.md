# Evaluation harness

Dev-only Node scorer. Uses the same q8 ONNX model, heuristics, and fusion as the Chrome extension. This does **not** ship inside the extension runtime.

## Prerequisites

```bash
npm ci
npm run fetch-model
```

Weights must exist at `models/onnx-community/ai-source-detector-ONNX/onnx/model_quantized.onnx`.

## Folder layout

Point the harness at a directory with labeled subfolders:

```
my-dataset/
  real/
    photo-001.jpg
    photo-002.png
  ai/
    gen-001.png
    gen-002.webp
```

Supported AI folder names: `ai`, `fake`, `generated`, `synthetic`  
Supported real folder names: `real`, `authentic`, `photo`, `natural`

Nested folders inherit the parent label when inside a labeled directory.

## Run

```bash
npm run eval -- ./my-dataset
```

Output:

1. CSV lines per image: `file,label,raw_score,neural_score,verdict,predicted_ai,reasons`
2. Summary with **balanced accuracy** at raw `0.65` when both `ai/` and `real/` folders are present

## Scoring details

- Neural: `p(AI) = 1 - p(real)` from `onnx-community/ai-source-detector-ONNX` (q8)
- Fusion: same `fuseScores()` as production (C2PA byte scan in Node; c2pa-web runs only in the extension offscreen doc)
- Eval decision: binary at raw fused score >= 0.65 (no UI remapping)
- URL hints cannot cross the threshold alone

## Bounty alignment

- No hardcoded image hashes or lookup tables
- Threshold is raw fused score, not remapped UI percent
