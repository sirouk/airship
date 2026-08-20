# Contributing to Airship

Thanks for helping improve Airship.

## Setup

- Use Node.js 22.13 or newer.
- Run `npm ci` for a clean install from the committed lockfile.
- Use `npm install` only when you intentionally add, remove, or upgrade dependencies and need to update `package-lock.json`.
- Start local development with `npm run dev`.

## Tests and checks

- Run focused unit tests with `npm run test -- src/path/to/file.test.ts`.
- Run focused browser tests with `npx playwright test e2e/name.spec.ts`.
- Run the full required gate with `npm run check` before you open or merge a pull request.

## Architecture and boundaries

Read these before large changes:

- [`docs/CANON.md`](docs/CANON.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/PROTOCOLS.md`](docs/PROTOCOLS.md)
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

Airship is browser-first. Keep provider, storage, and runtime boundaries explicit. Do not add features that imply hidden backend trust or host-level powers the browser does not actually have.

## Commits and pull requests

- Keep commits and pull requests focused.
- Explain the user-visible change and why it is needed.
- Add or update tests and docs when behavior changes.
- If a change affects boundaries, storage, providers, or release claims, update the relevant docs in the same pull request.

## Security, privacy, and quality

- Never commit secrets, tokens, private keys, live credentials, or personal data.
- Redact logs, screenshots, and recordings before sharing them.
- New work should preserve accessibility, security, and performance.
- UI changes should keep keyboard access, visible focus, touch targets, and readable contrast.
