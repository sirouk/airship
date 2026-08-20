# Edge portability acceptance

Airship's portability gate tests one client implementation across five browser/device profiles. It does not turn API presence into a capability claim. A primitive is promoted into the session prompt only after its corresponding probe passes; API-only observations remain explicitly labeled `api-exposed`, and every consuming runtime must still report the backend it actually activated.

Run the dedicated gate from `airship/`:

```sh
npm run test:e2e:portability
```

## Matrix

| Project | Contract |
| --- | --- |
| `chrome-stable-webgpu` | Uses the installed stable Google Chrome, requires a real adapter and device, compiles a compute pipeline, submits one workgroup, and waits for queue completion. This is a hard gate, not a skip. |
| `firefox-desktop-fallback` | Accepts a usable adapter when Firefox supplies one; otherwise requires an honest WASM semantic preference and fully usable local surfaces. |
| `webkit-iphone-14-pro-max` | Exercises iPhone-class viewport, touch, WebKit, and graceful accelerator/storage degradation. This is emulation, not a physical iPhone claim. |
| `chromium-tablet` | Exercises the same app at an iPad Pro-class viewport and touch profile without changing product code. This is emulation, not a physical tablet claim. |
| `chromium-constrained-2c-2gib` | Overrides the coarse browser signals to 2 logical cores, 2 GiB, data saver/2G, and 10% unplugged battery. The policy must select one worker, four-item vector batches, manual heavy-pack loading, low-power scheduling, and the WASM semantic path even if an adapter exists. It also requests reduced motion and verifies the app's animation, transition, and scroll behavior honors that preference. |

Every project also verifies:

- UI card state, evidence label, capability report, and composed session-prompt entries agree.
- An exposed `navigator.gpu`, `navigator.ml`, or OPFS-shaped API is never promoted when its readiness probe did not pass.
- Chat `/ls`, the Editor workspace tree/file surface, Terminal Shared Git `status`, and the session, operational-status, and storage surfaces remain usable without inference credentials.
- The Chat composer is keyboard-focusable, and the relevant tab lists keep roving focus with Left/Right keys while preserving `aria-selected`, `aria-controls`, and panel labeling.
- Capabilities, Chat, Editor, Terminal, and the operational-status surfaces do not introduce document/main-region horizontal overflow.
- Visible native controls have accessible names, visible images expose `alt`, IDs are unique, and the exercised tab/tabpanel relationships resolve on every matrix project.
- Uncaught page errors and browser-console errors fail the run.

## Deliberate host limits

- Playwright WebKit on macOS is a browser-engine and device-profile check; it is not Mobile Safari on physical Apple hardware and cannot establish thermal or battery hardware truth.
- Playwright device descriptors emulate viewport, user agent, touch, and related browser inputs. Physical iPhone, tablet, and low-end-device checks remain a separate manual/device-lab obligation.
- The semantic checks are deterministic markup and keyboard invariants, not an assistive-technology certification. VoiceOver, TalkBack, high-contrast/forced-colors, zoom/reflow, and representative disabled-user studies remain physical/device-lab obligations.
- Firefox WebGPU availability varies by Playwright browser build, OS, and driver. The Firefox gate is therefore future-safe: it accepts a genuinely acquired adapter, or verifies the honest WASM fallback when acquisition is unavailable.
- The constrained profile exercises scheduling policy with explicit init-script signals because desktop automation cannot safely alter the host's real battery, RAM, CPU, or thermal state. The test asserts each override took effect.
- The stable Chrome gate validates a real WebGPU compute submission. The optional semantic-model acceptance remains separate because it downloads a model pack: `AIRSHIP_LIVE_SEMANTIC=1 AIRSHIP_REQUIRE_WEBGPU=1 npx playwright test --config=playwright.semantic.config.ts`.
- The dedicated portability server owns strict port `4189`; the semantic-model gate owns `4190`; other release gates use their documented dedicated ports.
- No standardized browser thermal signal currently exists in these engines. Airship must continue to report that fact as unavailable rather than infer one.
