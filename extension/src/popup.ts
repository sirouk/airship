import {
  clearCompanionCache,
  inspectCompanionCapabilities,
  setCompanionCacheEnabled,
} from "./companion";
import { callerAllowlist, type BridgeChannel } from "./policy";
import { describePopupChannel, diagnoseCurrentTab } from "./popup-diagnostics";
import { resolveExtensionApi } from "./webextension";

declare const __AIRSHIP_BRIDGE_CHANNEL__: string;

const status = document.querySelector<HTMLElement>("[data-status]");
const toggle = document.querySelector<HTMLInputElement>("[data-cache-toggle]");
const clear = document.querySelector<HTMLButtonElement>("[data-cache-clear]");
const usage = document.querySelector<HTMLElement>("[data-cache-usage]");
const channelName = document.querySelector<HTMLElement>("[data-build-channel]");
const callerRules = document.querySelector<HTMLElement>("[data-caller-rules]");
const tabState = document.querySelector<HTMLElement>("[data-tab-state]");
const tabOrigin = document.querySelector<HTMLElement>("[data-tab-origin]");
const connectionLink = document.querySelector<HTMLAnchorElement>("[data-connection-link]");

const channel: BridgeChannel = __AIRSHIP_BRIDGE_CHANNEL__ === "development" ? "development" : "release";
const callers = callerAllowlist(channel);
const buildDiagnostic = describePopupChannel(channel, callers);
const api = resolveExtensionApi(globalThis as unknown as Record<string, unknown>);

renderBuildDiagnostic();

void refresh();

toggle?.addEventListener("change", () => {
  if (!toggle) return;
  toggle.disabled = true;
  void setCompanionCacheEnabled(toggle.checked)
    .then(refresh)
    .catch(() => showStatus("The cache setting could not be changed.", "failed"));
});

clear?.addEventListener("click", () => {
  if (!clear) return;
  clear.disabled = true;
  void clearCompanionCache()
    .then(refresh)
    .catch(() => showStatus("The extension cache could not be cleared.", "failed"));
});

async function refresh(): Promise<void> {
  const [capabilities, currentTabUrl] = await Promise.all([
    inspectCompanionCapabilities(),
    inspectCurrentTabUrl(),
  ]);
  const storage = capabilities.storage;
  if (toggle) {
    toggle.disabled = storage.state !== "available";
    toggle.checked = storage.enabled;
  }
  if (clear) clear.disabled = storage.state !== "available" || (storage.records ?? 0) === 0;
  if (usage) {
    usage.textContent = storage.state === "available"
      ? `${storage.records ?? 0} encrypted page${storage.records === 1 ? "" : "s"} · ${formatBytes(storage.usageBytes ?? 0)}`
      : storage.reason ?? "Unavailable";
  }
  renderCurrentTab(currentTabUrl);
  showStatus(
    storage.state === "available"
      ? storage.enabled
        ? "Extension-local encrypted cache is on."
        : capabilities.compute.state === "available"
          ? "Extension-local compute is ready. Encrypted cache is off."
          : "Encrypted cache is off. Extension-local compute is unavailable."
      : capabilities.compute.state === "available"
        ? "Extension-local compute is ready. Encrypted cache is unavailable."
        : "Extension-local cache and compute are unavailable.",
    storage.state === "available" ? "ready" : "attention",
  );
}

function renderBuildDiagnostic(): void {
  if (channelName) {
    channelName.textContent = `${buildDiagnostic.label} channel`;
    channelName.dataset.channel = buildDiagnostic.channel;
  }
  if (callerRules) {
    callerRules.replaceChildren(...buildDiagnostic.callerRules.map((rule) => {
      const item = document.createElement("code");
      item.textContent = rule;
      return item;
    }));
  }
  if (connectionLink && buildDiagnostic.connectionUrl) connectionLink.href = buildDiagnostic.connectionUrl;
}

function renderCurrentTab(rawUrl: string | undefined): void {
  const diagnostic = diagnoseCurrentTab(rawUrl, callers);
  if (tabState) {
    tabState.textContent = diagnostic.label;
    tabState.dataset.state = diagnostic.state;
  }
  if (tabOrigin) tabOrigin.textContent = diagnostic.origin;
}

async function inspectCurrentTabUrl(): Promise<string | undefined> {
  try {
    const tabs = await api?.tabs?.query({ active: true, currentWindow: true });
    return tabs?.[0]?.url;
  } catch {
    return undefined;
  }
}

function showStatus(message: string, state: "ready" | "attention" | "failed"): void {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
