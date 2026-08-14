# Clueside website

Static product website for [Clueside](https://clueside.com), the privacy-focused browser extension that surfaces local AI-image signals without uploading images. The website and extension share this repository while remaining separate build targets.

## Preview

```bash
npm run site:serve
```

Open <http://127.0.0.1:4173>.

## Validate

```bash
npm run site:check
```

The interactive detector is an explicitly illustrative scoring explainer. The 96.1% figure is a historical public result from an unshipped legacy raw-max policy, not the current policy and not a claim about POIDH's private evaluation set. The current CF-primary policy still needs a full rerun on the exact 893-image fixture.

## Deployment

The site is dependency-free HTML, CSS, JavaScript, and SVG under [`site/`](site/). Configure the hosting platform to publish `site` as the static output directory.

## License

[MIT](LICENSE) © 2026 Luis Felipe Abarca