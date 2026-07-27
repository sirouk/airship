(() => {
  const guidance = document.getElementById("browser-guidance");
  if (!(guidance instanceof HTMLElement)) return;
  const channelGuidance = document.getElementById("channel-guidance");
  const developmentOrigins = new Set([
    "http://localhost:4173",
    "http://127.0.0.1:4173",
  ]);
  const channel = developmentOrigins.has(location.origin) ? "development" : "release";
  document.documentElement.dataset.installChannel = channel;
  for (const candidate of document.querySelectorAll("[data-channel-download]")) {
    if (!(candidate instanceof HTMLAnchorElement)) continue;
    const href = channel === "development"
      ? candidate.dataset.developmentHref
      : candidate.dataset.releaseHref;
    const label = channel === "development"
      ? candidate.dataset.developmentLabel
      : candidate.dataset.releaseLabel;
    if (href) candidate.href = href;
    if (label) candidate.textContent = label;
  }
  if (channelGuidance instanceof HTMLElement) {
    const heading = document.createElement("strong");
    const detail = document.createElement("span");
    if (channel === "development") {
      heading.textContent = "Local Airship detected · Development channel selected";
      detail.textContent = "The primary downloads below include the exact localhost:4173 callers. Release packages intentionally refuse localhost.";
      channelGuidance.dataset.channel = "development";
      document.querySelector("[data-local-test]")?.classList.add("selected");
    } else {
      heading.textContent = "Release channel selected";
      detail.textContent = "These packages answer only the published Airship origin. Use the separately marked development packages for localhost:4173.";
      channelGuidance.dataset.channel = "release";
    }
    channelGuidance.replaceChildren(heading, detail);
  }
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/u.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const browser = /Edg\//u.test(ua)
    ? "edge"
    : /Firefox\//u.test(ua)
      ? "firefox"
      : /Chrome\//u.test(ua)
        ? "chrome"
        : /Safari\//u.test(ua)
          ? "safari"
          : undefined;

  const selected = browser && document.querySelector(`[data-browser="${browser}"]`);
  if (selected instanceof HTMLElement) {
    selected.classList.add("recommended");
    selected.setAttribute("aria-label", `${browser} package · detected browser`);
  }

  const channelLabel = channel === "development" ? "development" : "release";
  const message = mobile && (browser === "chrome" || browser === "edge")
    ? "This mobile browser does not install desktop WebExtensions. Airship remains a full PWA here; use Firefox Android after its signed listing is available, or install the desktop companion."
    : mobile && browser === "safari"
      ? "Safari on iPhone and iPad requires the signed Airship containing app from the App Store. The source package below is for Apple release engineering, not one-tap mobile installation."
      : mobile && browser === "firefox"
        ? "Firefox Android is the intended Android extension path. Permanent installation begins when Mozilla signs the Airship listing."
        : browser
          ? `We highlighted the ${channelLabel} package that matches this browser and this Airship origin. Until its store listing is signed, the download is a reviewed developer or conversion artifact.`
          : `Choose the ${channelLabel} package for your browser and this Airship origin. Permanent installation begins when the corresponding store signs the release.`;
  guidance.textContent = message;
  guidance.hidden = false;
})();
