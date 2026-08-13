# Evaluation harness

Score a folder of images with the same fusion logic as the extension (metadata heuristics + neural path stub).

## Prerequisites

```bash
npm ci
npm run fetch-model
```

## Run

```bash
npm run eval -- ./path/to/images
```

The harness walks `*.jpg`, `*.jpeg`, `*.png`, `*.webp` and prints CSV lines:

```
file,raw_score,neural_score,verdict,reasons
```

## Notes

- Full neural scoring in Node requires ONNX Runtime Node and is optional. Without it, the harness reports metadata-only fusion with `neural_score=0.5`.
- For benchmark runs, use the built extension popup or a scripted Chrome test with the offscreen pipeline.
- Default eval threshold is raw 0.65 (same as production).

## Bounty alignment

- No hardcoded image hashes or lookup tables
- Threshold is raw fused score, not remapped UI percent
- URL hints capped at +0.05
