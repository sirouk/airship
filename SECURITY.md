# Security Policy

## Supported versions

Airship is still pre-1.0.

| Branch or version | Status |
| --- | --- |
| `main` | Supported |
| Older branches, forks, and unmerged snapshots | Not supported |

Security fixes land on `main` first. Maintainers may backport fixes to a tagged release later, but older lines should not be assumed supported unless the repository says so explicitly.

## Reporting a vulnerability

Please do not open public issues for suspected vulnerabilities.

- Use GitHub's **Report a vulnerability** flow in the repository **Security** tab when it is available.
- If private vulnerability reporting is not enabled, contact the repository maintainers through another private GitHub channel and ask for a non-public reporting path before you share details.
- Include the affected commit or release, browser, provider, storage mode, reproduction steps, impact, and any logs with secrets removed.

## What to expect

Maintainers will review reports as time allows, acknowledge them when seen, and may ask for more detail or a retest. There is no guaranteed response or fix SLA.

## Scope and threat model

Airship runs in the browser and tries to keep its trust boundary explicit. Start with [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

When you report an issue, describe which boundary is crossed. Browser extensions, local malware, OS compromise, or direct DevTools access can still matter, but they should be framed against Airship's documented browser boundary rather than as hidden-server expectations.
