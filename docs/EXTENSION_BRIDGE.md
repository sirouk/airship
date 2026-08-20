# Airship browser-extension bridge

The companion extension is optional. It exists to help with browser-restricted
network paths and a few local acceleration tasks. It is not an Airship backend.

## What the extension may do

1. Relay a reviewed fixed-host request shape that an ordinary page cannot send
   or read directly.
2. Provide an optional ciphertext-only acceleration cache.
3. Provide bounded background helper work for local acceleration tasks.

## What the extension must not do

- store provider credentials durably;
- become the source of truth for sessions or vault state;
- turn a provider connection into a stronger trust tier;
- acquire a provider OAuth grant or expose a built-in account sign-in flow; or
- manufacture account authorization a provider did not already grant.

## Trust meaning

The extension changes reachability, not trust meaning.

- A remote provider turn remains `provider-tls`.
- A local loopback provider remains `loopback-local`.
- Installing the extension does not create remote attestation or confidential
  execution claims.

## Product rule

Airship must stay useful without the extension. If a provider or browser path
needs the extension, the UI should say so plainly and keep unrelated providers
working.
