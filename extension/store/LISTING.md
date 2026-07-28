# Airship Companion store listing

## Product name

Airship Companion

## Short description

Local acceleration and reviewed provider reach for the Airship edge agent.

## Full description

Airship Companion extends the Airship browser agent without adding an Airship
backend. It provides:

- a fixed-destination provider relay for protocols a normal web page cannot
  reach because of browser CORS/header restrictions;
- an optional, ciphertext-only local acceleration cache; and
- bounded background hashing and vector ranking that keeps those operations off
  the Airship interface thread.

The relay omits cookies, follows no redirects, accepts only reviewed methods and
headers, and has fixed request, response, deadline, and concurrency ceilings.
The encrypted cache is disabled by default and can be cleared from the popup.
Airship’s Vault remains authoritative.

Installing the extension does not authorize a provider account, create an
attestation, or embed a provider client secret. Airship offers account
authorization only when a separate reviewed provider grant flow is available.

## Category

Developer Tools / Productivity

## Single-purpose statement

Extend the Airship edge agent with bounded provider transport and opt-in local
acceleration while keeping provider credentials on the user’s device.

## Public URLs

- Install hub: `https://sirouk.github.io/airship/extension/`
- Privacy: `https://sirouk.github.io/airship/extension/privacy.html`
- Airship: `https://sirouk.github.io/airship/`

## Store publication state

- Chrome Web Store: package ready; publisher account upload/review pending.
- Microsoft Edge Add-ons: package ready; Partner Center upload/review pending.
- Mozilla AMO: package ready; signing/review pending.
- Apple App Store: source ready; Safari Web Extension Packager, bundle
  identifiers, signing, and app review pending.
