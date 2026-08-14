# Security Policy

Clueside is a browser extension with access to page image URLs, local model execution, and release automation. Please report security problems privately so users can be protected before technical details become public.

## Supported versions

| Version | Security fixes |
| --- | --- |
| `main` | Yes, for changes intended for the next release |
| Latest GitHub release | Yes |
| Older releases | No |

This table will advance with each release.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting form:

**https://github.com/arcacomputer/clueside/security/advisories/new**

If that form is unavailable, email **contact@arca.computer** with the subject **`[Clueside security]`**.

Please do not open a public issue for an unpatched vulnerability. Include, where practical:

- affected Clueside version or commit
- Chrome version and operating system
- impact and attack prerequisites
- minimal reproduction steps or proof of concept
- whether the problem involves page-image retrieval, extension permissions, local model assets, update handling, packaging, or the website

Do not send credentials, private keys, personal images, or unrelated browsing data. Use a synthetic test case when possible.

## Response and disclosure

The maintainers will acknowledge reports as soon as practical, validate the issue, and coordinate a fix and disclosure timeline according to severity. Please allow time for a patched release before publishing exploit details.

Clueside currently has no paid vulnerability bounty. Reporting does not create an entitlement to payment, but responsible reports will be credited when the reporter wants attribution and disclosure is safe.

## Scope notes

The detector's probabilistic accuracy is not a security boundary. False positives, false negatives, skipped images, and ordinary model-quality disagreements are product limitations rather than security vulnerabilities unless they enable a separate security impact.
