# Clueside website

Astro product website for [Clueside](https://clueside.com), the privacy-focused browser extension that surfaces local AI-image signals without uploading images. The website and extension share one repository but keep separate dependencies, builds, and deployment targets.

## Install

```bash
npm ci --prefix site
```

Astro and Wrangler are scoped to `site/`. The Chrome extension does not need these dependencies to build, test, or package.

## Develop

```bash
npm run site:dev
```

Open <http://127.0.0.1:4321>.

## Validate the production build

```bash
npm run site:check
```

This runs Astro diagnostics, builds `site/dist/`, and verifies required assets, disclosures, canonical URLs, sitemap output, and basic HTML invariants.

The interactive detector is an explicitly illustrative scoring explainer. The 96.1% figure is a historical public result from an unshipped legacy raw-max policy, not the current policy and not a claim about POIDH's private evaluation set. The current CF-primary policy still needs a full rerun on the exact 893-image fixture.

## Cloudflare deployment

The production target is Cloudflare Workers with Static Assets. Configuration lives at [`../wrangler.jsonc`](../wrangler.jsonc).

```bash
npm run site:deploy
```

The tiny Worker serves the Astro build and redirects `www.clueside.com` to the canonical apex domain. Cloudflare credentials stay outside the repository.

## License

[MIT](../LICENSE) © 2026 Luis Felipe Abarca
