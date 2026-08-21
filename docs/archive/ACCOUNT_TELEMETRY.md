# Chutes account telemetry

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../SIMPLIFICATION.md`](../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

Status: implemented browser client with localhost confidential PKCE, hosted public-client PKCE, and API-key compatibility  
Date: 2026-07-18

## Purpose

Airship's Account view answers four different questions without an Airship
backend:

1. What effective USD balance is available for pay-as-you-go work?
2. How much subscription-covered usage remains in the current plan cycle?
3. How much remains in the current fixed four-hour UTC burst bucket?
4. What quota and rate-limit state did the most recent invocation expose?

Those values are provider telemetry. They are not TEE evidence, conversation
receipts, Stripe entitlement proofs, or Airship-authored accounting records.

## Direct browser reads

`src/billing/client.ts` starts four independent, read-only requests in
parallel. Every request uses `credentials: omit`, `cache: no-store`, an
in-memory Bearer token, bounded response decoding, and the caller's
`AbortSignal`.

| Source | Chutes endpoint | Airship presentation |
| --- | --- | --- |
| Account | `GET /users/me` | username, subject, effective available balance |
| Quotas | `GET /users/me/quotas` | configured default/per-chute quota records |
| Subscription | `GET /users/me/subscription_usage` | monthly and four-hour covered-usage windows |
| Usage | `GET /users/me/usage` | actual charged USD, requests, and tokens for the current UTC month |

Usage is requested with `page=0`, `limit=1000`, and timezone-naive UTC
`start_date`/`end_date` values because that is the current API contract. A UTC
month has fewer than 1,000 hourly buckets, so this range is complete under the
current aggregation cadence. Partial source failures remain visible and do not
erase successful sources.

## Meaning of the numbers

- **Available Chutes balance** is the API's effective balance, not merely raw
  deposits. Current private-instance accrual can reduce it.
- **Actual charged usage** is the sum of `UsageData.amount`; subscription-
  covered usage can therefore be nonzero while actual charged usage is zero.
- **Covered plan usage** is the pay-as-you-go-equivalent amount absorbed by the
  plan for eligible public chutes.
- **Four-hour usage** is a fixed Unix/UTC-aligned bucket, not a rolling trailing
  four-hour interval. The UI always says “Fixed four-hour UTC bucket.”
- At a subscription cap, a funded account can continue through discounted
  pay-as-you-go overflow. With no effective balance, current enforcement can
  return HTTP 402.
- Quota records are per chute/default configuration. Airship does not sum them
  into a fictional global allowance.

The current tier formulas in `chutes-api` are:

```text
monthly covered cap = monthly price × 5
four-hour covered cap = monthly price / 180 × 75
```

Airship consumes the returned caps instead of recalculating account authority
in the browser.

## Live invocation telemetry

The E2EE transport parses the following CORS-exposed response headers into a
small memory-only snapshot:

```text
X-Chutes-Quota-Total
X-Chutes-Quota-Used
X-Chutes-Quota-Remaining
X-Chutes-RL-User
X-Chutes-RL-Chute
X-Chutes-InvocationID
```

The parser rejects malformed/negative values and treats `inf` as unlimited.
The callback is advisory: its failure can never fail an inference turn. These
headers are unsigned and currently describe the pre-invocation quota snapshot,
so the Account UI does not display a proof icon for them.

A live CORS preflight from `http://localhost:4173` on 2026-07-18 returned
wildcard origin access, allowed `Authorization`, and exposed the Chutes quota,
rate-limit, and invocation ID headers. Deployment must re-run this check for
the production origin and monitor it as a provider conformance dependency.

## Scope compatibility

The intended Airship registration now declares:

```text
profile chutes:invoke billing:read
```

The authorization request adds the OIDC protocol scope:

```text
openid profile chutes:invoke billing:read
```

`billing:read` is included because the app owner enabled the Account feature
and Chutes' public documentation describes it as the balance/credits grant.
Current `chutes-api` enforcement does not yet match that description:

- `/users/me`, `/users/me/quotas`, `/users/me/usage`, and
  `/users/me/subscription_usage` are classified as `account/read`;
- current `profile` parsing also grants `account/read`;
- `usage:read` maps to `invocations/read` and does not authorize the current
  `/users/me/usage` route;
- `billing:read` is privileged at app registration and does not grant the
  separate platform `billing_admin` role.

Consequently, today's self-service Account reads work through `profile`.
Airship still declares `billing:read` so consent reflects the enabled billing
surface and a future guard correction does not silently widen a basic profile
scope. The UI and tests must be updated when Chutes separates basic profile,
account, quota, usage, and billing permissions correctly.

## Credential boundary

The account client accepts a `cak_` user-scoped OAuth token or the user's own
normal `cpk_` API key. OAuth is preferred because consented scopes, identity,
refresh lifetime, and revocation are explicit; a `cpk_` remains the deliberate
compatibility path for users who want one credential for inference and account
standing. Airship never asks for an admin key.
Credentials live in page memory only and never appear in URLs, error messages,
storage, telemetry, or receipts.

The checked-in localhost registration is confidential in the deployed Chutes
service. The browser creates and proves S256 PKCE, while the same-origin local
token handler adds a process-held app secret. The secret never enters browser
JavaScript, the extension, the bundle, logs, or lab state. Static production
instead supplies its reviewed Browser/native registration as
`VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID` alongside an exact HTTPS
`VITE_AIRSHIP_PUBLIC_ORIGIN`. The build fails sign-in closed when those public
values are absent. A hosted registration must use token authentication `none`;
the discovery document alone does not convert a confidential app. Any client
secret pasted into chat, source, an extension, or a browser must be rotated at
Chutes immediately.

## Commerce boundary

Payment history, Stripe Checkout creation, subscription mutation, customer
portal sessions, invoices, and auto-top-up use Chutes' server-only billing
service key today. Airship does not copy or proxy those operations. The Account
view links to the Chutes-hosted billing page. A backend-free production flow
requires Chutes-hosted, user-authorized Checkout/Portal URLs or a new OAuth-
bound commerce API.
