import {
  clearCompanionCache,
  inspectCompanionCapabilities,
  setCompanionCacheEnabled,
} from "./companion";

const status = document.querySelector<HTMLElement>("[data-status]");
const toggle = document.querySelector<HTMLInputElement>("[data-cache-toggle]");
const clear = document.querySelector<HTMLButtonElement>("[data-cache-clear]");
const usage = document.querySelector<HTMLElement>("[data-cache-usage]");

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
  const capabilities = await inspectCompanionCapabilities();
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
  showStatus(
    storage.state === "available"
      ? storage.enabled
        ? "Encrypted acceleration cache is available to Airship."
        : "Provider relay is ready. Encrypted cache is off."
      : "Provider relay is ready. Extension storage is unavailable.",
    storage.state === "available" ? "ready" : "attention",
  );
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
