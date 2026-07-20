# Access, funding, and commerce

## Product rule

Payment may gate paid inference or optional Airship services. It must never gate reading, exporting, decrypting, or recovering a user's own workspace, Git repositories, receipts, or S3 data.

Airship keeps four authorities separate:

1. identity proves who the user is;
2. an optional Airship entitlement proves which Airship product features are active;
3. Chutes proves invocation scope and provider balance/quota;
4. attestation proves the selected confidential-compute endpoint and, where supported, the exact transcript execution.

The paid-inference predicate is therefore an intersection:

```text
identity valid
AND optional Airship entitlement active
AND Chutes credential active and properly scoped
AND Chutes balance/quota sufficient
AND requested attestation policy satisfied
```

An unknown result fails closed for paid inference but remains recoverable. The UI never compresses these independent facts into one decorative green lock.

## Preferred fully static lane: user-owned Chutes billing

The user connects their own Chutes identity. Inference goes directly from the device to Chutes and is billed directly to that Chutes account. Airship neither resells tokens nor holds a pooled provider key.

If balance is insufficient, the agent turn becomes durably `awaiting_funding`, Airship opens the Chutes top-up or subscription flow, and the client rechecks Chutes on return. When funding is visible, the same idempotent turn resumes without losing work. Chutes currently offers pay-as-you-go top-ups and optional Plus/Pro plans on its [pricing page](https://chutes.ai/pricing).

Chutes supports public applications (`public: true`) that exchange an
authorization code with S256 PKCE and no client secret. Airship uses that flow
directly from the registered browser origin, keeps access/refresh material in
page memory, and rotates refresh tokens through the provider. A confidential
registration still requires a secret and is therefore limited to the disclosed
loopback development bridge; it must never be embedded in a static build.

Users may instead choose an in-memory `cpk_` API key. Airship never embeds a
client secret or pooled inference key, and it does not silently fall back from
failed OAuth to an unrelated credential mode.

The browser-direct Account view is read-only. With a user-scoped `cak_` token
it loads `/users/me`, quotas, subscription usage, and UTC-month usage in
parallel, and it captures unsigned quota/rate-limit headers from inference.
A normal user-owned `cpk_` key can power inference and the current self-service
account reads, but lacks OAuth's consented-scope and refresh semantics; Airship
labels the active credential class and never asks for an admin key. The enabled development app declares `profile`,
`chutes:invoke`, and `billing:read`, plus `openid` in the authorization
request. Current API guards authorize the actual self-service accounting reads
through an unexpectedly broad `profile -> account/read` mapping; see
`ACCOUNT_TELEMETRY.md` for the compatibility matrix.

## Optional Airship subscription through Stripe

A static page can render a Stripe-hosted [Payment Link or Buy Button](https://docs.stripe.com/payment-links/buy-button) and can link to Stripe's hosted customer portal. It cannot securely fulfill the purchase by trusting the browser redirect. Stripe explicitly requires webhook-driven, idempotent [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment).

There are only two secure issuer choices:

- **Chutes partner issuer:** Stripe/Chutes confirms the purchase and Chutes mints a scoped Airship invocation capability. This best preserves a direct device → Chutes data path.
- **Airship Access Notary:** a tiny control-plane service verifies raw Stripe webhooks, reconciles identity, applies monotonic entitlement transitions, and issues short-lived signed capabilities. It sees commerce metadata, never prompts, workspaces, memory, or inference plaintext. It is still a backend and must be described as one.

[Stripe Entitlements](https://docs.stripe.com/billing/entitlements) can map products to features, but consuming entitlement changes still requires secret-key API access/webhooks and durable reconciliation. Stripe Payment Links alone are appropriate for voluntary purchases, not secure feature activation.

## Chutes subscription or top-up sold by Airship

Do not claim this is available without a commercial and technical integration from Chutes.

No current public Chutes API documents purchasing a subscription or topping up
another user's account. The documented balance-change and invoicing operations
are administrator-only, and the public OAuth scope is read-only for billing.
Chutes also directs automated/production-scale use to PAYGO rather than consumer
subscriptions. Stripe Connect can route money to a participating Chutes
connected account, but moving money does not mint Chutes inference authority or
associate a payment with a sponsored Airship subject.

Possible future structures are:

- a Chutes-owned Checkout/Payment Link opened by Airship, with the user's Chutes account as the billing authority;
- an approved reseller API in which Chutes mints provider credits or plan access after signed payment evidence;
- Stripe Connect destination charges if Chutes participates as a connected merchant and the parties agree who is merchant of record, who handles taxes, refunds, disputes, and chargebacks.

Stripe Billing Credits are not a shortcut for third-party Chutes credit. Stripe's [billing-credit rules](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) prohibit using credits as stored value or allowing them to be spent on third-party goods/services. Airship can use them only for its own metered service under an appropriate commercial model.

### Clean one-bill partnership

The preferred design is a Chutes-sponsored tenant: Airship pays one wholesale
or enterprise PAYGO invoice, while Chutes issues the browser a short-lived,
user-, device-key-, model-, and spend-bound invocation capability. Chutes
enforces the ceiling and returns a signed idempotent usage/cost receipt. No
pooled master key enters the browser, and encrypted request bytes still travel
directly from device to Chutes.

The partnership asks are therefore concrete:

1. public-client authorization code + PKCE without a client secret, refresh
   rotation, CORS, and preferably DPoP/device-key binding;
2. a parent Airship billing tenant with per-user/model/USD capability ceilings;
3. partner balance, quota, usage, and consolidated-invoice APIs;
4. signed per-invocation cost receipts, idempotency, revocation, and abuse
   controls; and
5. explicit reseller/merchant-of-record, tax, refund, dispute, and support
   terms.

If neither Stripe nor Chutes will be the capability issuer, the irreducible
fallback is a disclosed, tiny Access Notary: one webhook/event consumer stores
only opaque identity/commerce/entitlement records, and one grant endpoint mints
short-lived Chutes/storage capabilities. It is a control-plane backend, never
an agent, prompt, file, vector, or inference data backend. Stripe can deliver
events through [Amazon EventBridge](https://docs.stripe.com/event-destinations/eventbridge)
instead of a public webhook endpoint, but an authenticated consumer is still
required.

## Entitlement state machine

```text
unknown -> checkout_pending -> current
current -> grace -> current
grace -> past_due -> current
past_due -> suspended
current -> cancel_at_period_end -> expired
any nonterminal -> disputed/suspended
```

Webhook processing is ordered, replay-safe, and idempotent. A checkout success requires the expected product/price, currency, minimum amount, paid state, pre-existing identity binding, and a previously issued nonce/reference. Client-supplied email or Stripe metadata can corroborate a binding but cannot create account ownership.

Stripe's subscription states have distinct meanings; `past_due` is normally a recovery interval, while `unpaid` should revoke paid service according to [Stripe's subscription guidance](https://docs.stripe.com/billing/subscriptions/overview). The exact Airship grace policy is displayed before purchase.

## Access and funding panel

One compact panel presents separate verifiable rows:

- Identity — issuer, subject, authentication age, expiry;
- Airship Plan — product, state, renewal/grace, entitlement issuer;
- Chutes Connected — OAuth/key scope, expiry, key binding;
- Provider Funded — quota/balance freshness and direct link to fund;
- TEE Attested — endpoint, measurement policy, evidence age;
- Transcript Receipt — request/response/model/runtime commitment status.

Every icon expands to issuer, subject, scope, timestamps, verification method, digest/key ID, and a plain-language failure reason. “Good standing” is a derived presentation over these rows, never an unsigned client assertion.

## Lessons retained from ArcLink

Airship reuses ArcLink's proven principles—typed resumable onboarding, immutable terminal payment states, proof-token claims, locally authoritative ownership binding, ordered webhook replay ledgers, and provider access as the intersection of billing and scoped provider credentials. It does not copy ArcLink's backendful Python/SQLite architecture or its nautical lore. ArcLink itself describes that backendful boundary in `CANON.md`; Airship's static-client promise must remain materially different.

## Primary service references

- [Stripe Payment Links](https://docs.stripe.com/payment-links)
- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
- [Stripe Connect Payment Links](https://docs.stripe.com/connect/payment-links)
- [Stripe destination charges](https://docs.stripe.com/connect/destination-charges)
- [Chutes Sign in with Chutes](https://chutes.ai/docs/sign-in-with-chutes/overview)
- [Chutes Users API](https://chutes.ai/docs/api-reference/users)
- [Chutes pricing](https://chutes.ai/pricing)
- [Chutes terms](https://chutes.ai/terms)
