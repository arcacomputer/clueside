# Evaluation harness

Dev-only Node scorer. Uses the same q8 ONNX source-detector, heuristics, and fusion as the Chrome extension.

## Prerequisites

```bash
npm ci
npm run fetch-model
```

Weights must exist at `models/onnx-community/ai-source-detector-ONNX/onnx/model_quantized.onnx`.

Optional binary CIFAKE head for experiments only (not shipped in the extension):

```bash
npm run fetch-model -- --with-binary
```

## Folder layout

Point the harness at a directory with labeled subfolders:

```
my-fixture/
  real/
    cat.jpg
    food.jpg
  ai/
    pluto.png
    windmill-mj.png
```

Supported AI folder names: `ai`, `fake`, `generated`, `synthetic`  
Supported real folder names: `real`, `authentic`, `photo`, `natural`

## Run

```bash
npm run eval -- ./my-fixture
npm run eval -- ./my-fixture --compare-legacy
```

Output:

1. CSV lines per image
2. Balanced accuracy at raw `0.65` when both `ai/` and `real/` folders exist
3. With `--compare-legacy`, also prints balanced accuracy for the old `1 - p(real)` mapping

## Scoring change (why)

The 5-class source detector (`stable_diffusion`, `midjourney`, `dalle`, `real`, `other_ai`) spreads softmax mass across four AI heads. Using `p(AI) = 1 - p(real)` treats that entire tail as AI probability and inflates scores on ordinary photographs (landscapes, food, animals).

Production neural score:

- `argmax == real` -> `p(AI) = max(AI head probabilities)`
- `argmax` is an AI class -> `p(AI) = that class score`, with a small lift from secondary AI mass when borderline (0.55-0.64)

Threshold stays raw `0.65`. No UI remapping.

## Measured results

### Public 19-image fixture (local, not in git)

Prior mapping (`1 - p(real)`) on the maintainer fixture: **59.44%** balanced accuracy at 0.65 (8/9 AI recall, 3/10 real recall). Heuristics did not fire on that run.

Re-run on the same layout after checking out main:

```bash
npm run eval -- /path/to/your/19-image-fixture --compare-legacy
```

### Wikimedia proxy (3 real photos, Aug 2026)

Small sanity check on public Wikimedia JPEGs (`cat`, `food`, `puppies`):

| Image | Legacy 1-p(real) | New top-AI head | Legacy pred | New pred |
|-------|------------------|-----------------|-------------|----------|
| cat | 0.83 | 0.43 | AI | real |
| food | 0.64 | 0.19 | uncertain | real |
| puppies | 0.74 | 0.26 | AI | real |

This confirms the hypothesis on spread-mass false positives. It is not a claim about the full 19-image fixture until you re-run locally.

### Binary CIFAKE ensemble (not shipped)

We tested `onnx-community/ai-image-detection-ONNX` (CIFAKE, Apache-2.0) as an ensemble head. On the same Wikimedia real photos it labeled `cat` at 73% Fake and `food` at 99% Fake, increasing false positives. It is available via `fetch-model --with-binary` for `eval/compare-scoring.mjs` experiments only.

## Bounty alignment

- No hardcoded image hashes or lookup tables
- Threshold is raw fused score, not remapped UI percent
- URL hints cannot cross the threshold alone
