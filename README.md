# Clueside website

Static product website for [Clueside](https://clueside.com), the privacy-focused browser extension that surfaces local AI-image signals without uploading images.

The extension and its inference code live in [`felirami/hybrid-ai-image-detector`](https://github.com/felirami/hybrid-ai-image-detector). This repository contains only the standalone website.

## Preview

```bash
npm run serve
```

Open <http://127.0.0.1:4173>.

## Validate

```bash
npm run check
```

The interactive detector is an explicitly illustrative scoring explainer. The 96.1% figure is a public, reproducible 893-image benchmark result from the extension repository, not a claim about POIDH's private evaluation set.

## Deployment

The site is dependency-free HTML, CSS, JavaScript, and SVG under [`site/`](site/). Configure the hosting platform to publish `site` as the static output directory.

## License

[MIT](LICENSE) © 2026 Luis Felipe Abarca