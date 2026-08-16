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

The interactive detector is an explicitly illustrative scoring explainer. The 96.1% figure is a historical public result from an unshipped legacy raw-max policy, not the current policy and not a claim about POIDH's private evaluation set. The current CF-primary policy measures 87.9% balanced accuracy (76.0% TPR, 99.8% TNR) on the exact 893-image fixture; see eval/benchmark-results.json, the single source of truth the site build is checked against.

## Cloudflare deployment

The production target is Cloudflare Workers with Static Assets. Configuration lives at [`../wrangler.jsonc`](../wrangler.jsonc).

```bash
npm run site:deploy
```

Routine deployments upload an immutable Worker version and move production traffic to it without reconfiguring DNS or custom-domain triggers. Pushes to `main` that change website or Worker files use the same versioned flow through GitHub Actions.

The initial custom-domain setup, or a deliberate trigger change, requires the wider zone-routing permission and uses:

```bash
npm run site:deploy:triggers
```

The tiny Worker serves the Astro build, forces production HTTP traffic onto HTTPS, and redirects `www.clueside.com` to the canonical apex domain. Cloudflare credentials stay outside the repository.

## License

[MIT](../LICENSE) © 2026 Luis Felipe Abarca
