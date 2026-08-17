# AGENTS.md

**Read this file first.** Strict operating rules for anyone working on [arcacomputer/clueside](https://github.com/arcacomputer/clueside). Public voice: Luis Felipe Abarca. License: MIT.

Official bounty text and field notes: [docs/POIDH-323.md](docs/POIDH-323.md).

---

## Goal

Win POIDH Arbitrum bounty 323 by shipping a privacy-first local MV3 Chrome extension that Kenny can build from this public GitHub and score **>= 75.0% balanced accuracy** at a **RAW 65% threshold** on his **private** held-out set, with **low false positives on real photos**.

---

## Hard bans (instant reject / do not ship)

- **Cloud inference.** External AI APIs. Sending image bytes or pixels off-device.
- **Local Python / Node / Flask / any localhost backend.** Eval blocks localhost.
- **Extra model / weight / WASM downloads after initial setup.** Prefer weights bundled at build (`npm run fetch-model`) so a fresh Chrome profile with net cut after install still works. Runtime Hugging Face downloads are a reject risk.
- **Hardcoded image hashes, per-image lookup tables, or eval circumvention.**
- **Score remapping / Platt / logit shift** that paints a raw 0.02 as displayed 65%. Competitors (Proofmark, anudit, RealGuard, Rajesh, PixelWitness) do this. **We do not.** `DEFAULT_THRESHOLD` stays **0.65** on the raw fused p(AI).
- **Wrapping or replacing `<img>` / `<picture>`** (IKEA product grids collapse). Badges stay on `document.body`, `position:fixed`.
- **Undocumented or non-redistributable third-party assets.** Original project code stays MIT. Bundled model/runtime licenses must be compatible with redistribution and included in `THIRD_PARTY_NOTICES.md` and the release zip.
- **Chrome Web Store publish** or paying the $5 developer fee unless the repo owner explicitly asks.
- **On-chain POIDH claim, wallet connect, gas spend, or "we won" public claim** without the repo owner's explicit OK.
- **Invented metrics, fake screenshots, or citing any public benchmark as Kenny's private score.** It is not.

---

## Product rules

- **Manifest V3.** `onnxruntime-web` in an offscreen document. WebGPU with WASM fallback (probe the adapter; do not latch a WebGPU error).
- **Auto-scan ordinary webpages.** Confidence on every badge: AI / OK / uncertain.
- **Hybrid is allowed:** neural + C2PA + EXIF/XMP + PNG/JPEG comments + weak URL hints. A URL hint alone must not cross 0.65.
- **Current fusion: CF-primary, three tiers plus view agreement.** CommunityForensics TTA takes the maximum raw sigmoid from inspected views, with one rule: a lone view in [0.65, 0.95) does not carry an AI verdict and falls back to the runner-up (live CDN-processed real photos spike single crops); views >= 0.95 keep single-view authority and early-exit. The adaptive extras band is [0.15, 0.95). The page queue never sheds TTA to center-only: adaptive already skips extras on confident reals, and shedding disabled agreement on busy Unsplash walls. CF is authoritative at >= 0.65 after agreement. Sub-floor tier: below CF 0.02, rescue only when CF >= 0.0005 AND DINO >= 0.995. Strong tier: CF in [0.02, 0.20) needs DINO >= 0.96. Normal tier: CF in [0.20, 0.65) needs DINO >= 0.70. The flat-graphic gate blocks every rescue tier. Bands derived under four simultaneous guards: public bench, 240-image stress set, a held-out live-CDN guard (camera-EXIF-verified Unsplash variants), and a held-out product-CDN guard (IKEA/Amazon imagery). Those four fixtures are not in git; `eval/fetch-live-guard.mjs` builds a smaller runnable stand-in. **Do not restore plain max(CF, DINO), remove the graphic gate or the agreement rule, restore center-only load-shed, or loosen these bands without rerunning the bench, the stress set, the live guard, AND the product guard.**
- **Overlay:** badge store must be an iterable `Map`, not a `WeakMap`. Reposition on scroll / resize / `visualViewport` / mutations. Never wrap images.
- **Load-unpacked users do not auto-update.** GitHub Releases zip + popup banner is the update path. Do not assume CWS.
- **Cross-device:** macOS (owner), Windows, Linux. WASM must work when WebGPU has no adapter.

---

## How Kenny will judge

- Build from public GitHub, clean Chrome, fresh profile.
- Net off after initial model download. Localhost APIs blocked.
- **65% raw threshold.**
- Balanced accuracy on a **private** set. False positives on real photos will sink a claim (see comment on 1014).
- **Live sites matter:** Wikipedia, Unsplash, Lummi, IKEA sofa grid. Unsplash photographer photos and IKEA catalog shots must not mass-label AI 100%.
- Public benches (Tiny-GenImage, n=80, n=893) are directional only. If they disagree with a live Unsplash wall, believe the wall.
- First legitimate qualifying claim wins. Speed without quality loses (LocalLens author admitted this).

---

## How to work in this repo

- Small reversible PRs. Evidence before claims. Quote file paths.
- Add or extend tests for fusion and overlay when you touch them.
- Report numbers you actually ran (n, TPR, TNR, BA, fixture). Never invent.
- Do not clone advice: keep weights out of git; fetch at build; release workflow attaches the zip on tags.
- Public GitHub voice is Luis Felipe Abarca. **No em dashes in public copy.**

---

## Current architecture (short reference)

| File | Role |
|---|---|
| `src/fuse.js` | `DEFAULT_THRESHOLD` 0.65, `DINO_CF_FLOOR` 0.02, `DINO_STRONG_RESCUE_FLOOR` 0.20, `DINO_STRONG_RESCUE_MIN` 0.96, `DINO_RESCUE_MIN` 0.70, `DINO_SUBFLOOR_CF_MIN` 0.0005, `DINO_SUBFLOOR_MIN` 0.995, CF-primary `fuseNeuralScores` |
| `src/graphic-gate.js` | Shared flat-graphic policy for browser and Node evaluation |
| `src/pixel-resize.js` | Pillow-exact bicubic resize shared by the extension and the Node harness for the CF path (byte-exact vs Pillow 12.3.0 goldens) |
| `src/offscreen.js` | ORT WebGPU/WASM, DINO 224 then CF TTA |
| `src/content.js` | scan, fixed badges, `Map` badgeByEl |
| `src/community-forensics.js` | CommunityForensics ViT head |
| `src/dino.js` | DINOv2 probe head |
| `src/heuristics.js` | metadata fusion |
| `src/c2pa-reader.js` | C2PA reader |

- Issue 23 (fixed in PR 24 / v1.0.7): overlay WeakMap drift + DINO max false positives.
- The public 893-image fixture with the live-guarded policy: 87.9% BA, 76.0% TPR, 99.8% TNR (last full harness run, v1.3.2 adaptive path, early-exit 0.85). That fixture is not in this checkout and was not re-scored for v1.3.3. Stress set: 3 FPs in 240 images (same caveat). Live-CDN guard (132 held-out camera-EXIF Unsplash variants, AVIF plus JPEG): 4 FPs, 3.0%, vs 9.2% for v1.2.0 on identical bytes; that 3.0% was measured with full adaptive TTA, not the center-only load-shed the live Unsplash masonry actually used. Product-CDN guard (100 held-out IKEA/Amazon images): 3 FPs, 3.0%, two of three CF-driven. Probe v5 trained on 11,721 rows including ~1.9k hard-negative reals, 118 verified-real live CDN images, and 198 product-CDN negatives. Smoke history: v1.2.0 24.3% flags on assumed-real pages (FAIL), v1.3.0 9.0% confirmed-real FPs (FAIL, product imagery), v1.3.1 3.21% confirmed-real FPs (PASS on accuracy) with a WebGPU worker wedge under GPU contention; v1.3.2 shipped the wedge watchdog. A v1.3.2 live Unsplash featured-feed pass still failed (15 AI of 26 badges, 81-94%). v1.3.3 (current) never sheds TTA and raises early-exit to 0.95. See docs/live-smoke-2026-08-16.md for the isolation work.

---

## Competing claims (do not copy their reject patterns)

Known as of 2026-08-13. Full notes: [docs/POIDH-323.md](docs/POIDH-323.md#field-notes-2026-08-13).

- 1014 LocalLens: remap 0.5 to 65
- 1015 Caravela CF: runtime HF download
- 1016 Six-Fingers: Platt, int8
- 1018 synthcheck: closest honest bundled MIT
- 1020 Proofmark: remap ~2% to 65%, old-gen bench
- 1025 Blur: rejected DINO for FPR; private 95.6% full-res, 67% thumbnails
- 1027 sieve: 2026 fine-tune, setup download, unpublished 36k
- 1028 pixilated: Unsplash FPR measured 12.9% after refit; off by default
