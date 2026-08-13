# Evaluation harness

Dev-only Node scorer. Uses the same models, heuristics, and fusion as the extension.

## Prerequisites

```bash
npm ci
npm run fetch-model
```

Downloads:

- `onnx-community/ai-image-detect-distilled-ONNX` (~15MB q8, MIT, primary neural head)
- `onnx-community/ai-source-detector-ONNX` (~83MB q8, generator hints only)

## Folder layout

```
my-fixture/
  real/
    cat.jpg
  ai/
    pluto.png
```

## Run

```bash
npm run eval -- ./my-fixture
npm run eval -- ./my-fixture --strategy=hybrid
npm run eval -- ./my-fixture --sweep
```

`--sweep` prints balanced accuracy for `distilled`, `hybrid`, `legacy`, and `max_ai` on the same folder.

## Neural strategies

| Strategy | Mapping | Notes |
|----------|---------|-------|
| `distilled` (production) | `p(AI) = p(fake)` from ai-image-detect-distilled | Binary MIT model trained on MJ/SD vs real |
| `hybrid` | argmax AI -> `1-p(real)`; argmax real -> `max(AI head)` | Measured alternative; not production |
| `legacy` | `1-p(real)` on 5-class source detector | PR #1 baseline (59.44% BA on 19-image fixture) |
| `max_ai` | `max(AI head)` only | PR #2 (50.00% BA on 19-image fixture; always below 0.65) |

Threshold is raw `0.65` for all strategies. No UI remapping.

## Reported measurements

### 19-image public fixture (maintainer local, not in git)

| Strategy | AI recall | Real recall | Balanced accuracy |
|----------|-----------|-------------|-------------------|
| legacy (`1-p(real)`) | 8/9 | 3/10 | 59.44% |
| max_ai (PR #2) | 0/9 | 10/10 | 50.00% |
| hybrid | re-run required | re-run required | re-run required |
| distilled (this PR) | re-run required | re-run required | re-run required |

Re-run after checkout:

```bash
npm run eval -- /path/to/19-image-fixture --sweep
```

### Wikimedia proxy (3 real photos, Aug 2026)

Scores at 0.65 threshold on public Wikimedia JPEGs (`cat`, `food`, `puppies`). Inference is cached once per file during `--sweep` so strategies share the same model outputs.

| Strategy | cat | food | puppies | FP @ 0.65 |
|----------|-----|------|---------|-----------|
| legacy | 0.87 | 0.64 | 0.83 | 2/3 |
| hybrid | 0.87 | 0.19 | 0.83 | 2/3 |
| max_ai | 0.41 | 0.19 | 0.45 | 0/3 |
| distilled | 0.30 | 0.61 | 0.25 | 0/3 |

Hybrid only helps when the 5-class argmax is `real` (food here). When argmax is an AI class on a real photo (cat, puppies), hybrid still uses `1-p(real)` and false positives remain. Distilled binary scores stay below 0.65 on all three.

### CIFAKE binary (not shipped)

`onnx-community/ai-image-detection-ONNX` scored the same Wikimedia `cat` at 73% Fake. Optional fetch: `npm run fetch-model -- --with-cifake`.

## Bounty alignment

- No hardcoded image hashes
- Raw 0.65 threshold, no score remapping
- URL hints cannot cross threshold alone
