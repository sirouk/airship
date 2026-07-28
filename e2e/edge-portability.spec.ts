import { expect, test, type Page, type TestInfo } from "@playwright/test";

type ProbeState = "available" | "unavailable" | "failed";
type ProbeEvidence = "probe-passed" | "api-exposed" | "not-observed" | "probe-failed";

type Observation = Readonly<{
  state: ProbeState;
  evidence: ProbeEvidence;
  detail: string;
}>;

type PortabilitySnapshot = Readonly<{
  report: {
    webgpu: Observation;
    webnn: Observation;
    wasm: Observation & { features: Readonly<Record<string, boolean>> };
    opfs: Observation;
    serviceWorker: Observation;
    cacheStorage: Observation;
    webCodecs: Observation;
    webTransport: Observation;
    signals: {
      logicalProcessors?: number;
      deviceMemoryGiB?: number;
      battery: { state: ProbeState; charging?: boolean; level?: number };
      connection: { state: ProbeState; effectiveType?: string; saveData?: boolean };
      thermal: { state: "unavailable"; detail: string };
    };
    scheduling: {
      class: "constrained" | "balanced" | "performance";
      maxWorkerConcurrency: number;
      embeddingBatchSize: number;
      heavyPackLoading: "manual" | "lazy-on-demand";
      preferredSemanticBackend: "webgpu" | "wasm";
      powerPreference: "high-performance" | "low-power" | "default";
      reasons: readonly string[];
    };
  };
  entries: readonly Readonly<{ id: string; evidence: "probe-passed" | "api-exposed"; detail: string }>[];
  prompt: string;
  apiPresence: Readonly<{ webgpu: boolean; webnn: boolean; opfs: boolean }>;
  constrainedOverrides?: Readonly<Record<string, boolean>>;
}>;

const DEVICE_CARD_TITLES = Object.freeze({
  webgpu: "WebGPU",
  webnn: "WebNN",
  opfs: "OPFS",
  wasm: "WebAssembly",
} as const);

test("edge runtime is honest and useful across the portability matrix", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await installPortabilityEnvironment(page, testInfo);
  const runtimeErrors = observeRuntimeErrors(page);

  await page.goto("/#capabilities");
  await expect(page.getByRole("heading", { name: "Capabilities", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Device acceleration", level: 2 })).toBeVisible();
  await expect(page.getByText(/each workload reports its active backend\./iu)).toBeVisible();

  const snapshot = await readCapabilityAndPromptSnapshot(page);
  testInfo.annotations.push({
    type: "capability-report",
    description: [
      `webgpu=${snapshot.report.webgpu.state}/${snapshot.report.webgpu.evidence}`,
      `webnn=${snapshot.report.webnn.state}/${snapshot.report.webnn.evidence}`,
      `opfs=${snapshot.report.opfs.state}/${snapshot.report.opfs.evidence}`,
      `schedule=${snapshot.report.scheduling.class}`,
      `semantic=${snapshot.report.scheduling.preferredSemanticBackend}`,
    ].join("; "),
  });
  await testInfo.attach("browser-capability-report.json", {
    body: JSON.stringify(snapshot, null, 2),
    contentType: "application/json",
  });
  assertPromptPromotionContract(snapshot);
  await assertCapabilityCards(page, snapshot);
  await expectNoPageOverflow(page, "Capabilities");
  await expectSemanticAccessibility(page, "Capabilities");

  if (testInfo.project.name === "chrome-stable-webgpu") {
    expect(snapshot.apiPresence.webgpu).toBe(true);
    expect(snapshot.report.webgpu).toMatchObject({ state: "available", evidence: "probe-passed" });
    expect(snapshot.entries.map(({ id }) => id)).toContain("webgpu-adapter");
    await expectRealWebGpuComputeSubmission(page);
  } else {
    expect(snapshot.report.scheduling.preferredSemanticBackend).toBe(
      snapshot.report.webgpu.state === "available" && snapshot.report.scheduling.class !== "constrained"
        ? "webgpu"
        : "wasm",
    );
  }

  if (testInfo.project.name === "chromium-constrained-2c-2gib") {
    expect(snapshot.constrainedOverrides).toMatchObject({
      hardwareConcurrency: true,
      deviceMemory: true,
      connection: true,
      battery: true,
    });
    expect(snapshot.report.signals).toMatchObject({
      logicalProcessors: 2,
      deviceMemoryGiB: 2,
      battery: { state: "available", charging: false, level: 0.1 },
      connection: { state: "available", effectiveType: "2g", saveData: true },
    });
    expect(snapshot.report.scheduling).toMatchObject({
      class: "constrained",
      maxWorkerConcurrency: 1,
      embeddingBatchSize: 4,
      heavyPackLoading: "manual",
      powerPreference: "low-power",
      preferredSemanticBackend: "wasm",
    });
    expect(snapshot.report.scheduling.reasons).toEqual(expect.arrayContaining([
      "limited logical processors",
      "limited reported device memory",
      "low battery while unplugged",
      "data-saving or constrained network",
    ]));
    await expectReducedMotionContract(page);
  }

  await exerciseCoreLocalSurfaces(page);
  // Let late worker failures surface before accepting the page. A caught,
  // honestly presented unsupported-runtime state is fine; an uncaught page or
  // console error is not graceful degradation.
  await page.waitForTimeout(300);
  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);
});

async function installPortabilityEnvironment(page: Page, testInfo: TestInfo): Promise<void> {
  const constrained = testInfo.project.name === "chromium-constrained-2c-2gib";
  if (constrained) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ constrainedProfile }) => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "full-access",
    }));
    if (!constrainedProfile) return;

    const override = (key: string, value: unknown): boolean => {
      try {
        Object.defineProperty(navigator, key, { configurable: true, value });
        return (navigator as unknown as Record<string, unknown>)[key] === value;
      } catch {
        return false;
      }
    };
    const connection = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(connection, { effectiveType: "2g", saveData: true, downlink: 0.5, rtt: 800 });
    const battery = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(battery, { charging: false, level: 0.1 });
    const getBattery = async () => battery;
    const results = {
      hardwareConcurrency: override("hardwareConcurrency", 2),
      deviceMemory: override("deviceMemory", 2),
      connection: override("connection", connection),
      battery: override("getBattery", getBattery),
    };
    Object.defineProperty(globalThis, "__airshipPortabilityOverrides", {
      configurable: true,
      value: Object.freeze(results),
    });
  }, { constrainedProfile: constrained });
}

function observeRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const source = message.location().url;
    const text = message.text();
    // Firefox surfaces StackBlitz's rejected cross-site analytics cookies as
    // JavaScript errors. Browser privacy enforcement on a third-party runtime
    // delivery frame is not an uncaught Airship-origin failure.
    if (source.startsWith("https://stackblitz.com/headless")
      && /Cookie .* rejected .* cross-site context .*SameSite/iu.test(text)) return;
    errors.push(`console${source ? ` (${source})` : ""}: ${text}`);
  });
  return errors;
}

async function readCapabilityAndPromptSnapshot(page: Page): Promise<PortabilitySnapshot> {
  return page.evaluate(async () => {
    const capabilities = await import("/src/capabilities/browser-runtime.ts");
    const charter = await import("/src/core/operating-charter.ts");
    // CapabilitiesView has already populated the shared page-memory registry.
    // A non-forced refresh returns those exact observations rather than racing
    // the UI with a second adapter request.
    const report = await capabilities.getBrowserCapabilityRegistry().refresh();
    const entries = capabilities.browserCapabilityPromptEntries(report);
    const prompt = charter.composeAirshipOperatingPrompt("Portability acceptance profile.", [], [], entries);
    return {
      report,
      entries,
      prompt,
      apiPresence: {
        webgpu: "gpu" in navigator,
        webnn: "ml" in navigator,
        opfs: typeof navigator.storage?.getDirectory === "function",
      },
      constrainedOverrides: (globalThis as typeof globalThis & { __airshipPortabilityOverrides?: Record<string, boolean> })
        .__airshipPortabilityOverrides,
    };
  }) as Promise<PortabilitySnapshot>;
}

function assertPromptPromotionContract(snapshot: PortabilitySnapshot): void {
  const ids = new Set(snapshot.entries.map(({ id }) => id));
  expect(ids.has("webgpu-adapter")).toBe(
    snapshot.report.webgpu.state === "available" && snapshot.report.webgpu.evidence === "probe-passed",
  );
  expect(ids.has("webnn-context")).toBe(
    snapshot.report.webnn.state === "available" && snapshot.report.webnn.evidence === "probe-passed",
  );
  expect(ids.has("opfs-root")).toBe(
    snapshot.report.opfs.state === "available" && snapshot.report.opfs.evidence === "probe-passed",
  );
  expect(ids.has("wasm-baseline")).toBe(
    snapshot.report.wasm.state === "available" && snapshot.report.wasm.evidence === "probe-passed",
  );
  for (const [feature, supported] of Object.entries(snapshot.report.wasm.features)) {
    expect(ids.has(`wasm-${feature}`)).toBe(supported);
  }

  for (const entry of snapshot.entries) {
    expect(snapshot.prompt).toContain(`- ${entry.id} [${entry.evidence}]: ${entry.detail}`);
    if (entry.evidence === "api-exposed") {
      expect(snapshot.prompt).toContain(`${entry.id} [api-exposed]`);
    }
  }
  expect(snapshot.prompt).toContain("not an execution grant or proof that a workload is using an accelerator");
  expect(snapshot.prompt).toContain("consuming runtimes report their active backend separately");
  expect(snapshot.entries.every(({ evidence }) => evidence === "probe-passed" || evidence === "api-exposed")).toBe(true);

  // An API-shaped property by itself must not create a probe-passed prompt pin.
  if (snapshot.apiPresence.webgpu && snapshot.report.webgpu.evidence !== "probe-passed") {
    expect(ids).not.toContain("webgpu-adapter");
  }
  if (snapshot.apiPresence.webnn && snapshot.report.webnn.evidence !== "probe-passed") {
    expect(ids).not.toContain("webnn-context");
  }
  if (snapshot.apiPresence.opfs && snapshot.report.opfs.evidence !== "probe-passed") {
    expect(ids).not.toContain("opfs-root");
  }
}

async function assertCapabilityCards(page: Page, snapshot: PortabilitySnapshot): Promise<void> {
  for (const [id, title] of Object.entries(DEVICE_CARD_TITLES) as [keyof typeof DEVICE_CARD_TITLES, string][]) {
    const observation = snapshot.report[id];
    const card = page.locator(".capability-device-card").filter({
      has: page.getByRole("heading", { name: title, level: 3 }),
    });
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(new RegExp(`(?:^|\\s)${observation.state}(?:\\s|$)`, "u"));
    await expect(card).toContainText(probeLabel(observation));
    await expect(card).toContainText(observation.detail);
  }
}

function probeLabel(observation: Observation): string {
  if (observation.state === "failed") return "Probe failed";
  if (observation.evidence === "probe-passed") return "Probe passed";
  if (observation.evidence === "api-exposed") return "API observed";
  return "Unavailable";
}

async function expectRealWebGpuComputeSubmission(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & {
      gpu?: {
        requestAdapter(): Promise<{
          requestDevice(): Promise<{
            pushErrorScope(filter: string): void;
            popErrorScope(): Promise<{ message?: string } | null>;
            createShaderModule(descriptor: { code: string }): unknown;
            createComputePipeline(descriptor: Record<string, unknown>): unknown;
            createCommandEncoder(): {
              beginComputePass(): { setPipeline(pipeline: unknown): void; dispatchWorkgroups(count: number): void; end(): void };
              finish(): unknown;
            };
            queue: { submit(commands: unknown[]): void; onSubmittedWorkDone(): Promise<void> };
            destroy(): void;
          }>;
        } | null>;
      };
    }).gpu;
    if (!gpu) return { activated: false, detail: "navigator.gpu was absent" };
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { activated: false, detail: "requestAdapter returned null" };
    const device = await adapter.requestDevice();
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code: "@compute @workgroup_size(1) fn main() {}" });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const validationError = await device.popErrorScope();
    device.destroy();
    return validationError
      ? { activated: false, detail: validationError.message ?? "WebGPU validation failed" }
      : { activated: true, detail: "device acquired and one compute workgroup completed" };
  });
  expect(result, result.detail).toMatchObject({ activated: true });
}

async function exerciseCoreLocalSurfaces(page: Page): Promise<void> {
  await page.goto("/#chat");
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();
  await composer.fill("/ls");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/README\.md/iu).last()).toBeVisible();
  await expectNoPageOverflow(page, "Chat");
  await expectSemanticAccessibility(page, "Chat");

  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();
  await page.getByRole("treeitem", { name: /README\.md/iu }).click();
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toBeVisible();
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) > 640) {
    await expect(page.getByRole("tab", { name: /Source Control/iu })).toBeVisible();
  }
  await expectNoPageOverflow(page, "Editor");
  await expectSemanticAccessibility(page, "Editor");

  await page.goto("/#terminal");
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();
  await expect(page.getByLabel(/browser terminal/iu)).toBeVisible();
  const setup = page.locator("details.terminal-route__setup");
  if ((await setup.getAttribute("open")) === null) await setup.locator("summary").click();
  const bridge = page.locator(".terminal-git-bridge");
  await expect(bridge).toContainText("Authoritative Editor/source-control state");
  await bridge.getByRole("textbox").fill("git status");
  await expect(bridge.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await bridge.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".terminal-route__footer")).toContainText(
    "Shared Git command completed against the authoritative browser repository.",
  );
  await expectNoPageOverflow(page, "Terminal");
  await expectSemanticAccessibility(page, "Terminal");

  await page.goto("/#proof");
  await expect(page.getByRole("heading", { name: "Proof", level: 1 })).toBeVisible();
  const summaryTab = page.getByRole("tab", { name: "Receipt & journal" });
  const evidenceTab = page.getByRole("tab", { name: "Attestation evidence" });
  await expect(summaryTab).toHaveAttribute("aria-selected", "true");
  await expect(summaryTab).toHaveAttribute("aria-controls", "proof-panel-summary");
  await expect(evidenceTab).toHaveAttribute("aria-controls", "proof-panel-attestations");
  await summaryTab.focus();
  await summaryTab.press("ArrowRight");
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  await expect(evidenceTab).toBeFocused();
  await evidenceTab.press("ArrowLeft");
  await expect(summaryTab).toHaveAttribute("aria-selected", "true");
  await expect(summaryTab).toBeFocused();
  await expectNoPageOverflow(page, "Proof");
  await expectSemanticAccessibility(page, "Proof");
}

async function expectNoPageOverflow(page: Page, surface: string): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    documentOverflow: document.documentElement.scrollWidth - innerWidth,
    mainOverflow: (document.querySelector<HTMLElement>("main.main")?.scrollWidth ?? 0)
      - (document.querySelector<HTMLElement>("main.main")?.clientWidth ?? 0),
  }));
  expect(geometry.documentOverflow, `${surface} exceeded the ${String(geometry.viewport)}px viewport`).toBeLessThanOrEqual(1);
  expect(geometry.mainOverflow, `${surface} main region overflowed horizontally`).toBeLessThanOrEqual(1);
}

async function expectReducedMotionContract(page: Page): Promise<void> {
  const observation = await page.evaluate(() => {
    const sample = document.querySelector<HTMLElement>("button");
    const style = sample ? getComputedStyle(sample) : undefined;
    const seconds = (value: string | undefined): number[] => (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.endsWith("ms")
        ? Number.parseFloat(entry) / 1_000
        : Number.parseFloat(entry));
    return {
      requested: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationSeconds: seconds(style?.animationDuration),
      transitionSeconds: seconds(style?.transitionDuration),
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });
  expect(observation.requested).toBe(true);
  expect(observation.animationSeconds.every((value) => value <= 0.001)).toBe(true);
  expect(observation.transitionSeconds.every((value) => value <= 0.001)).toBe(true);
  expect(observation.scrollBehavior).not.toBe("smooth");
}

async function expectSemanticAccessibility(page: Page, surface: string): Promise<void> {
  const violations = await page.evaluate(() => {
    const issues: string[] = [];
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const labelledByText = (element: Element): string => (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    const accessibleName = (element: Element): string => {
      const aria = element.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      const labelled = labelledByText(element);
      if (labelled) return labelled;
      const title = element.getAttribute("title")?.trim();
      if (title) return title;
      if (element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement) {
        const labels = [...(element.labels ?? [])]
          .map((label) => label.textContent?.trim() ?? "")
          .filter(Boolean);
        if (labels.length > 0) return labels.join(" ");
      }
      return element.textContent?.trim() ?? "";
    };

    const idCounts = new Map<string, number>();
    for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
      const id = element.id;
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of idCounts) {
      if (count > 1) issues.push(`duplicate id #${id} (${String(count)})`);
    }

    for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
      if (visible(image) && !image.hasAttribute("alt")) issues.push("visible image is missing alt");
    }
    for (const control of document.querySelectorAll<HTMLElement>(
      "button, input:not([type='hidden']), textarea, select, [role='button']",
    )) {
      if (visible(control) && !accessibleName(control)) {
        issues.push(`${control.tagName.toLowerCase()}${control.getAttribute("role") ? `[role=${control.getAttribute("role")}]` : ""} has no accessible name`);
      }
    }
    for (const tab of document.querySelectorAll<HTMLElement>("[role='tab']")) {
      if (!tab.hasAttribute("aria-selected")) issues.push("tab is missing aria-selected");
      const target = tab.getAttribute("aria-controls");
      if (target && !document.getElementById(target)) issues.push("tab aria-controls target is missing");
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[role='tabpanel']")) {
      const label = panel.getAttribute("aria-labelledby");
      if (!label || !document.getElementById(label)) issues.push("tabpanel aria-labelledby target is missing");
    }
    return issues;
  });
  expect(violations, `${surface} semantic accessibility violations:\n${violations.join("\n")}`).toEqual([]);
}
