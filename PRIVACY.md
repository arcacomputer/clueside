# Privacy Policy

**Hybrid AI Image Detector**  
Author: Luis Felipe Abarca  
Last updated: August 2026

## Summary

This extension analyzes images entirely on your device. Image bytes are not uploaded to any server for inference or storage.

## What stays local

- Webpage images fetched through the extension service worker (same URL as the page, for pixel decode only)
- Files you drop into the popup
- Model inference (WebGPU or WASM in an offscreen document)
- Metadata parsing (C2PA, EXIF, embedded text)
- Settings (threshold, enable toggle) via `chrome.storage.sync`

## What may use the network

- **One-time model download** during setup (`npm run fetch-model` at build time, or first-run Hugging Face fetch into Cache Storage if weights are missing). After that, the extension does not download model weights again.
- **Ordinary page loads** still use the site's own network traffic; this extension does not add cloud inference calls.

## Permissions

| Permission | Why |
|------------|-----|
| `host_permissions` `<all_urls>` | Fetch image URLs from pages you visit so pixels can be decoded without canvas taint (CORS bypass for analysis only) |
| `offscreen` | Run ONNX inference in a document with DOM/WebGPU |
| `storage` | Save your threshold and toggle preferences |
| `activeTab` | Optional context for the current tab |

## Data we do not collect

- No analytics
- No image uploads
- No account system
- No external inference APIs

## Contact

Issues and source: repository README. License: MIT.
