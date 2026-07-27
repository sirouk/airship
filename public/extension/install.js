(() => {
  const guidance = document.getElementById("browser-guidance");
  if (!(guidance instanceof HTMLElement)) return;
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

  const message = mobile && (browser === "chrome" || browser === "edge")
    ? "This mobile browser does not install desktop WebExtensions. Airship remains a full PWA here; use Firefox Android after its signed listing is available, or install the desktop companion."
    : mobile && browser === "safari"
      ? "Safari on iPhone and iPad requires the signed Airship containing app from the App Store. The source package below is for Apple release engineering, not one-tap mobile installation."
      : mobile && browser === "firefox"
        ? "Firefox Android is the intended Android extension path. Permanent installation begins when Mozilla signs the Airship listing."
        : browser
          ? "We highlighted the package that matches this browser. Until its store listing is signed, the download is a reviewed developer or conversion artifact."
          : "Choose the source package for your browser. Permanent installation begins when the corresponding store signs the release.";
  guidance.textContent = message;
  guidance.hidden = false;
})();
