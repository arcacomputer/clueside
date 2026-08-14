# POIDH Arbitrum bounty 323

**Public repo:** [felirami/hybrid-ai-image-detector](https://github.com/felirami/hybrid-ai-image-detector)  
**Author:** Luis Felipe Abarca  
**License:** MIT

This document records the official bounty text, maintainer clarifications, evaluation protocol, claim mechanics, and field notes so contributors can work without guessing.

---

## Metadata (not part of official body)

| Field | Value |
|---|---|
| Title | local AI challenge: AI image detector for Chrome |
| URL | https://poidh.xyz/arbitrum/bounty/323 |
| Chain | Arbitrum |
| Issuer | poidhbot (Kenny is the contact: https://x.com/kennyistyping) |
| Reward at capture | 1.36 ETH, 2 contributors (so an accepted claim goes through a 48-hour contributor vote, not instant payout) |
| Status at capture | open, winner-take-all, no deadline. First legitimate claim that meets ALL criteria takes the prize. |

---

## Verbatim bounty text

The block below is copied verbatim from https://poidh.xyz/arbitrum/bounty/323 (captured 2026-08-13). Do not treat paraphrases elsewhere as authoritative.

> First submission to clear the bar takes home the bounty.
>
> (This bounty is open-ended. Anyone may contribute additional funding to the prize pool at any time before a claim is submitted for vote. In return, you will receive voting rights on approving claims.)
>
> **the challenge**
>
> Build a Google Chrome extension that reliably detects AI-generated images using only the compute available inside the browser.
> - No cloud inference.
> - No external APIs.
> - No local server dependencies.
> - Everything must run entirely inside the browser runtime.
>
> Install the extension, visit any webpage, and AI-generated images should automatically be identified with a confidence score.
> The goal is to create a detector that is genuinely useful for everyday browsing while preserving user privacy by never sending image data to a remote server.
>
> **requirements**
>
> Your submission must:
> - Be fully open source under the MIT License.
> - Run as a native Manifest V3 Google Chrome extension.
> - Perform all inference locally using browser technologies such as WebGPU, WebAssembly, or WebGL.
> - The extension may perform a one-time download of publicly available model weights during initial setup. After that, all inference must run entirely offline and the extension may not download additional models, weights, or inference-related assets.
> - Automatically analyze images displayed on ordinary webpages.
> - Display a confidence score for every analyzed image.
> - Include complete build and installation instructions.
> - Be fully reproducible from source.
>
> Any browser-local detection approach is permitted, including learned models, metadata analysis, watermark detection, hybrid pipelines, or other techniques.
>
> **the bar**
>
> To win this bounty, your extension must achieve at least 75.0% balanced accuracy on our evaluation benchmark while using a 65% confidence threshold.
> Balanced accuracy gives equal weight to correctly identifying both real and AI-generated images.
> The benchmark consists of a held-out set of real and AI-generated images assembled from publicly available datasets and additional web-realistic samples.
> The exact evaluation images will remain private until the bounty concludes to discourage benchmark overfitting. The evaluation methodology and scoring process will remain consistent for every submission.
> We evaluated an existing open-source browser-based detector—which itself relies on a local backend server rather than pure in-browser inference—and it failed to achieve 60% balanced accuracy on our benchmark. This suggests there is significant room for improvement under these constraints.
>
> **evaluation**
>
> When you believe your extension is ready:
> - Submit a claim linking to your public GitHub repository.
> - The maintainers will independently build your extension from source.
> - The extension will be evaluated using a clean Chrome installation and a fresh browser profile.
> - Internet access will be disabled after the initial model download and native localhost APIs will be blocked.
> - The extension will be tested against the maintainer benchmark using the required 65% confidence threshold.
> - You will receive the evaluation results.
>
> If your submission reaches the qualifying score and complies with every rule below, you win the bounty.
>
> **rules**
>
> Your submission may not:
> - Use cloud inference.
> - Send image data to external services.
> - Depend on local Python, Node.js, Flask, or similar backend processes.
> - Download additional models after initial setup.
> - Hardcode benchmark image hashes or lookup tables.
> - Circumvent the evaluation process.
>
> The maintainers reserve the right to disqualify any submission that technically satisfies the letter of these rules while clearly violating their spirit.
> The objective of this bounty is to create a practical, easy-to-use, privacy-preserving AI image detector that performs real inference entirely inside a Chrome extension.
>
> **winner-take-all**
>
> The first submission that legitimately achieves 75.0% balanced accuracy wins the entire prize pool.
> A qualifying submission must:
> - Meet or exceed the required score.
> - Build successfully from source.
> - Be fully reproducible.
> - Comply with every rule above.
> - Be licensed under the MIT License.
>
> If multiple qualifying submissions are received before verification is complete, priority will be given to the earliest valid submission.
>
> **Special Note**
>
> If, after significant community participation, it becomes clear that the qualifying threshold is unrealistically high, the bounty creator and contributors may collectively amend the required score before any winner is declared. In this case, we would likely choose to reward the best performing extension that meets the spirit of the bounty.
> However, we also reserve the right to cancel this bounty (and refund all contributors) should the benchmark not be met and it is clear that there will not be an extension that comes close to meeting the rest of the bounty requirements.
>
> **open source license**
>
> All submissions must be released under the MIT License.
> The purpose of this bounty is not simply to reward one implementation—it is to create open infrastructure that anyone can study, improve, and build upon.
>
> **why this matters**
>
> Most "AI-powered" browser tools aren't actually running AI in your browser—they upload your data to a remote server for inference. That means every image you check is shared with a third party.
> This bounty asks a harder question: Can we build a detector that's genuinely useful while keeping every image entirely on the user's device?
> The challenge extends beyond AI image detection. Modern browser technologies like WebGPU and WebAssembly have only recently made local inference practical. Solving this problem could establish techniques for a new generation of fast, private, browser-native AI applications.
> If successful, the result will be an open-source foundation for privacy-preserving AI image detection that anyone can use and improve.
>
> **questions?**
>
> If you're unsure whether your approach satisfies the spirit of the challenge, feel free to contact Kenny on X with any questions: https://x.com/kennyistyping
>
> This bounty is voluntary, non-binding, and payout is contingent on meeting the qualifying bar — no compensation for partial progress or submissions that don't clear it. Evaluation decisions are at maintainer discretion and final. Subject to poidh.xyz's terms.

---

## Kenny clarifications (not official body, binding in practice)

These comments are from Kenny (https://x.com/kennyistyping) on POIDH and related threads. They are not part of the verbatim bounty body above, but they govern how claims are judged in practice.

- "the first legitimate claim that meets all the criteria takes the prize!"
- They review thoroughly for BOTH AI detection AND false positives.
- Claim 1014 (LocalLens) was thanked and queued for test; a third party said 1014 flags a lot of real photos as AI.
- Hidden/duplicate claims exist (1017 was a Six-Fingers duplicate).

---

## Evaluation protocol (maintainer process)

When a submission is ready, the maintainer workflow is:

1. Submit a POIDH claim linking to the public GitHub repository (see claim mechanics below).
2. Maintainers independently build the extension from source.
3. Evaluation uses a clean Chrome installation and a fresh browser profile.
4. Internet access is disabled after the initial model download; native localhost APIs are blocked.
5. The extension is tested against the private maintainer benchmark at a **65% raw confidence threshold**.
6. Balanced accuracy (equal weight to real and AI correctness) must reach **>= 75.0%**.
7. The submitter receives evaluation results.

Disqualifiers include cloud inference, off-device image bytes, localhost backends, post-setup model downloads, hardcoded benchmark hashes or lookup tables, and score remapping that makes a raw low probability display as 65%.

Live browsing behavior matters. False positives on real photos (stock sites, catalog grids, encyclopedia images) can sink an otherwise high score.

Public benchmarks in this repo (for example the 893-image local bench at 79.8% BA for the v1.0.8 production policy) are directional only. They are **not** Kenny's private held-out score. Do not cite them as proof of bounty qualification. The higher 96.1% legacy raw-max result is not shipped because its live false-positive behavior is unacceptable.

---

## POIDH claim mechanics

From https://docs.poidh.xyz/using-poidh/claiming-a-bounty.html:

- A claim is minted as an NFT. An image is required. The title cannot contain URLs. The GitHub link goes in the description.
- This bounty has 2 contributors, so after the creator nominates a claim there is a **48-hour vote**, not instant payout.
- Do **not** connect a wallet or submit an on-chain claim from this repository's automation. Only the repo owner may authorize a claim.

---

## Field notes (2026-08-13)

Known competing claims and reject patterns. Do not copy their failure modes.

| Claim | Notes |
|---|---|
| 1014 LocalLens | Score remapping (0.5 displayed as 65%). Queued for maintainer test. Third-party report: many real photos flagged as AI. |
| 1015 Caravela CF | Runtime Hugging Face model download after setup. |
| 1016 Six-Fingers | Platt scaling, int8 weights. Duplicate hidden claim 1017. |
| 1018 synthcheck | Closest honest bundled MIT competitor at time of capture. |
| 1020 Proofmark | Remap ~2% raw to 65% display. Old-gen bench tuning. |
| 1025 Blur | Rejected DINO for false-positive rate. Private 95.6% full-res, 67% thumbnails. |
| 1027 sieve | 2026 fine-tune, setup download, unpublished 36k model. |
| 1028 pixilated | Unsplash false-positive rate measured 12.9% after refit; off by default. |

Other competitors named in maintainer threads: anudit, RealGuard, Rajesh, PixelWitness. Several use score remapping or Platt-style calibration that paints low raw scores as 65%.

This repo's v1.0.8 candidate uses center-plus-strongest CF TTA averaging and CF-primary fusion with `DEFAULT_THRESHOLD` 0.65 on raw fused p(AI). A 2026-08-13 live smoke covered Unsplash, IKEA, Lummi, and Wikipedia. The captured known-real sample still had 7 false positives in 31 images, so broader live validation remains required before any claim.
