import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const TOKEN = "google-browser-acceptance-token";
const REQUIRED_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];

test("Google Identity Services loads through the reviewed Trusted Types boundary", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://accounts.google.com/gsi/client", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `globalThis.google={accounts:{oauth2:{initTokenClient(options){return{requestAccessToken(){queueMicrotask(()=>options.callback({error:"interaction_required"}))}}}}}};`,
    });
  });

  await page.goto("/#vault");

  await expect(page.getByRole("heading", { name: "Connect your Google Drive" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover with Google Drive" })).toBeEnabled();
  await expect(page.locator(".google-drive-setup__status")).toHaveCount(0);
  expect(pageErrors.filter((message) => message.includes("TrustedScriptURL"))).toEqual([]);
});

test("real browser UI adopts and recovers the encrypted Google Drive vault through GIS and Drive HTTP boundaries", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const drive = new BrowserDriveService();
  await installGoogleIdentityBoundary(page);
  await page.route("https://openidconnect.googleapis.com/**", async (route) => {
    drive.observeAuthorization(route);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: googleHeaders(),
      body: JSON.stringify({ sub: "google-browser-user-123", email: "pilot@airship.test", email_verified: true, name: "Airship Pilot" }),
    });
  });
  await page.route("https://www.googleapis.com/**", (route) => drive.handle(route));

  await page.goto("/#vault");
  await expect(page.getByRole("heading", { name: "Connect your Google Drive" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover with Google Drive" })).toBeEnabled();
  await page.getByRole("button", { name: "Create a new workspace" }).click();
  await page.getByLabel("New workspace folder").fill("Airship Browser Acceptance");
  const recovery = page.locator(".google-drive-setup output");
  await expect(recovery).toHaveText(/^airship-wrk-v1\./);
  const recoveryValue = await recovery.textContent();
  await page.getByLabel("I saved this recovery key").check();
  await page.getByRole("button", { name: "Create with Google Drive" }).click();

  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Google Drive · encrypted", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider contract verified", { exact: true })).toBeVisible();
  await expect(page.locator(".vault-view__configuration")).toContainText("Google Drive");
  await expect(page.locator(".vault-view__configuration")).toContainText("Airship Browser Acceptance");
  const readiness = page.getByRole("list", { name: "Verified vault capabilities" });
  await expect(readiness.getByRole("listitem").filter({ hasText: "Conditional create" })).toContainText("Verified");
  await expect(readiness.getByRole("listitem").filter({ hasText: "Compare and swap" })).toContainText("Verified");
  await expect(readiness.getByRole("listitem").filter({ hasText: "Exact ranges" })).toContainText("Verified");

  await page.getByRole("button", { name: "Renew Google access" }).click();
  const approval = page.getByRole("dialog", { name: /Allow vault_live_conformance once/ });
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByRole("button", { name: "Renew Google access" })).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByText("Provider contract verified", { exact: true })).toBeVisible();

  const gis = await page.evaluate(() => (window as typeof window & { __airshipGoogleAcceptance: {
    scopes: string[];
    prompts: string[];
  } }).__airshipGoogleAcceptance);
  expect(gis.scopes).toHaveLength(1);
  expect(gis.scopes[0]!.split(/\s+/u).sort()).toEqual([...REQUIRED_SCOPES].sort());
  expect(gis.prompts).toEqual(["select_account", ""]);

  // A second, storage-empty browser context imports only the one-time recovery
  // value and obtains its own expiring Google grant. It must rediscover the
  // exact app-owned folder hierarchy and encrypted object index; it may not
  // create a competing authority just because no Airship browser state exists.
  const recoveredContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4187",
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
  });
  try {
    await installGoogleIdentityBoundary(recoveredContext);
    const recoveredPage = await recoveredContext.newPage();
    await recoveredPage.route("https://openidconnect.googleapis.com/**", async (route) => {
      drive.observeAuthorization(route);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: googleHeaders(),
        body: JSON.stringify({ sub: "google-browser-user-123", email: "pilot@airship.test", email_verified: true, name: "Airship Pilot" }),
      });
    });
    await recoveredPage.route("https://www.googleapis.com/**", (route) => drive.handle(route));

    await recoveredPage.goto("/#vault");
    await expect(recoveredPage.getByRole("heading", { name: "Connect your Google Drive" })).toBeVisible();
    const workspaceFoldersBeforeRecovery = drive.filesByRole("workspace").length;
    await recoveredPage.getByLabel("Existing Airship recovery key").fill(`airship-wrk-v1.${"A".repeat(43)}`);
    await recoveredPage.getByRole("button", { name: "Recover with Google Drive" }).click();
    await expect(recoveredPage.locator(".google-drive-setup__status")).toContainText("No Airship workspace matching this recovery key exists", { timeout: 30_000 });
    expect(drive.filesByRole("workspace")).toHaveLength(workspaceFoldersBeforeRecovery);

    await recoveredPage.getByLabel("Existing Airship recovery key").fill(recoveryValue ?? "");
    await recoveredPage.getByRole("button", { name: "Recover with Google Drive" }).click();
    await expect(recoveredPage.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(recoveredPage.getByText("Google Drive · encrypted", { exact: true })).toBeVisible();
    await expect(recoveredPage.locator(".vault-view__configuration")).toContainText("Airship Browser Acceptance");
    await expect(recoveredPage.getByText("Provider contract verified", { exact: true })).toBeVisible();

    const recoveredPersisted = await persistedBrowserText(recoveredPage);
    expect(recoveredPersisted).not.toContain(TOKEN);
    expect(recoveredPersisted).not.toContain(recoveryValue ?? "unavailable-recovery-value");
  } finally {
    await recoveredContext.close();
  }

  // Renamed, not moved: one host handler had two button labels, and Drive got
  // the one in Airship's failure grammar. Both branches now render the Local
  // Device wording, so this journey clicks the same control by its one name.
  await page.getByRole("button", { name: "Switch to ephemeral · keep a page copy" }).click();
  /*
   * The visible carrier, not "the one carrier". `dc257d5` gave the phone shell
   * its own runtime line and left both in the DOM at every width, so this
   * locator has resolved to two elements ever since — and `toHaveText` with a
   * string is strict, so it failed on the count before it ever read the text.
   * The two are display-exclusive; filtering on visibility asks the question
   * this assertion was always asking.
   */
  await expect(page.locator(".runtime-line__text").filter({ visible: true }).first()).toHaveText(
    "Vault disconnected · active workspace continues in page memory",
    { timeout: 60_000 },
  );
  await expect(page.getByText("Ephemeral · page memory only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a durable provider" })).toBeVisible();
  await expect(page.getByText("No endpoint, credential authority, or workspace key is attached.")).toBeVisible();

  expect(drive.authorizationHeaders.length).toBeGreaterThan(20);
  expect(new Set(drive.authorizationHeaders)).toEqual(new Set([`Bearer ${TOKEN}`]));
  expect(drive.rangeReads).toBeGreaterThan(0);
  expect(drive.successfulConditionalWrites).toBeGreaterThan(0);
  expect(drive.rejectedConditionalWrites).toBeGreaterThan(0);
  expect(drive.filesByRole("object-index-v1")).toHaveLength(1);
  expect(drive.filesByRole("encrypted-segment-v1").length).toBeGreaterThan(8);
  expect(drive.filesByRole("object-index-v1")[0]!.text()).not.toContain(".airship-probes/v1");
  expect(drive.filesByRole("encrypted-segment-v1").some((file) => file.text().includes('"ciphertext"'))).toBe(true);

  const persisted = await persistedBrowserText(page);
  expect(persisted).not.toContain(TOKEN);
  expect(persisted).not.toContain("client_secret");
  expect(persisted).not.toContain(recoveryValue ?? "unavailable-recovery-value");
});

async function installGoogleIdentityBoundary(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(({ token, scopes }) => {
    localStorage.clear();
    sessionStorage.clear();
    const state = { scopes: [] as string[], prompts: [] as string[] };
    Object.defineProperty(window, "__airshipGoogleAcceptance", { value: state, configurable: false });
    Object.defineProperty(window, "google", {
      configurable: false,
      value: {
        accounts: { oauth2: { initTokenClient(options: { scope: string; callback(response: unknown): void }) {
          state.scopes.push(options.scope);
          return { requestAccessToken(request: { prompt?: string } = {}) {
            state.prompts.push(request.prompt ?? "");
            queueMicrotask(() => options.callback({ access_token: token, expires_in: 3_600, scope: scopes.join(" ") }));
          } };
        } } },
      },
    });
  }, { token: TOKEN, scopes: REQUIRED_SCOPES });
}

async function persistedBrowserText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const values: unknown[] = [document.cookie, { ...localStorage }, { ...sessionStorage }];
    if (typeof indexedDB.databases === "function") {
      for (const database of await indexedDB.databases()) {
        if (!database.name) continue;
        values.push(await new Promise<unknown>((resolve) => {
          const request = indexedDB.open(database.name!);
          request.onerror = () => resolve({ database: database.name, unreadable: true });
          request.onsuccess = () => {
            const db = request.result;
            const stores = [...db.objectStoreNames];
            if (!stores.length) { db.close(); resolve({ database: database.name, stores: [] }); return; }
            const transaction = db.transaction(stores, "readonly");
            const output: Record<string, unknown> = {};
            let remaining = stores.length;
            for (const name of stores) {
              const all = transaction.objectStore(name).getAll();
              all.onsuccess = () => { output[name] = all.result; if (--remaining === 0) { db.close(); resolve({ database: database.name, output }); } };
              all.onerror = () => { output[name] = "unreadable"; if (--remaining === 0) { db.close(); resolve({ database: database.name, output }); } };
            }
          };
        }));
      }
    }
    return JSON.stringify(values, (_key, value) => value instanceof CryptoKey ? { cryptoKey: true, extractable: value.extractable } : value);
  });
}

type StoredFile = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  bytes: Buffer;
  modifiedTime: string;
  etag: string;
  text(): string;
};

class BrowserDriveService {
  private sequence = 20_000;
  private readonly files = new Map<string, StoredFile>();
  readonly authorizationHeaders: string[] = [];
  rangeReads = 0;
  successfulConditionalWrites = 0;
  rejectedConditionalWrites = 0;

  observeAuthorization(route: Route): void {
    this.authorizationHeaders.push(route.request().headers()["authorization"] ?? "");
  }

  filesByRole(role: string): StoredFile[] {
    return [...this.files.values()].filter((file) => file.appProperties.airshipRole === role);
  }

  async handle(route: Route): Promise<void> {
    this.observeAuthorization(route);
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    const uploadMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: googleHeaders() }); return; }
    if (method === "GET" && url.pathname === "/drive/v3/files") return this.list(route, url);
    if (method === "POST" && url.pathname === "/drive/v3/files") return this.createFolder(route);
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") return this.createMultipart(route);
    if (method === "PATCH" && fileMatch) return this.rename(route, decodeURIComponent(fileMatch[1]!));
    if (method === "PATCH" && uploadMatch) return this.updateMedia(route, decodeURIComponent(uploadMatch[1]!));
    if (method === "GET" && fileMatch && url.searchParams.get("alt") === "media") return this.media(route, decodeURIComponent(fileMatch[1]!));
    await route.fulfill({ status: 404, headers: googleHeaders(), body: "not found" });
  }

  private async list(route: Route, url: URL): Promise<void> {
    const query = url.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/u.exec(query)?.[1];
    const role = /key='airshipRole' and value='([^']+)'/u.exec(query)?.[1];
    const namespace = /key='airshipNamespace' and value='([^']+)'/u.exec(query)?.[1];
    const files = [...this.files.values()].filter((file) =>
      (!parent || file.parents.includes(parent)) && (!role || file.appProperties.airshipRole === role) && (!namespace || file.appProperties.airshipNamespace === namespace),
    ).map((file) => this.metadata(file));
    await route.fulfill({ status: 200, contentType: "application/json", headers: googleHeaders(), body: JSON.stringify({ files }) });
  }

  private async createFolder(route: Route): Promise<void> {
    const metadata = JSON.parse(route.request().postData() ?? "{}") as FileMetadata;
    const file = this.insert(metadata, Buffer.alloc(0));
    await route.fulfill({ status: 200, contentType: "application/json", headers: googleHeaders(), body: JSON.stringify(this.metadata(file)) });
  }

  private async createMultipart(route: Route): Promise<void> {
    const contentType = route.request().headers()["content-type"] ?? "";
    const boundary = /boundary=([^;]+)/u.exec(contentType)?.[1];
    const body = route.request().postDataBuffer();
    if (!boundary || !body) { await route.fulfill({ status: 400, body: "bad multipart" }); return; }
    const firstHeaderEnd = body.indexOf(Buffer.from("\r\n\r\n"));
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), firstHeaderEnd + 4);
    const metadata = JSON.parse(body.subarray(firstHeaderEnd + 4, nextBoundary).toString("utf8")) as FileMetadata;
    const secondHeaderEnd = body.indexOf(Buffer.from("\r\n\r\n"), nextBoundary + boundary.length + 4);
    const finalBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}--`), secondHeaderEnd + 4);
    const file = this.insert(metadata, body.subarray(secondHeaderEnd + 4, finalBoundary));
    await route.fulfill({ status: 200, contentType: "application/json", headers: googleHeaders({ etag: file.etag }), body: JSON.stringify(this.metadata(file)) });
  }

  private async rename(route: Route, id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) { await route.fulfill({ status: 404, headers: googleHeaders() }); return; }
    const patch = JSON.parse(route.request().postData() ?? "{}") as { name?: string };
    if (patch.name) file.name = patch.name;
    await route.fulfill({ status: 200, contentType: "application/json", headers: googleHeaders(), body: JSON.stringify(this.metadata(file)) });
  }

  private async updateMedia(route: Route, id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) { await route.fulfill({ status: 404, headers: googleHeaders() }); return; }
    if (route.request().headers()["if-match"] !== file.etag) {
      this.rejectedConditionalWrites += 1;
      await route.fulfill({ status: 412, headers: googleHeaders() });
      return;
    }
    file.bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
    file.etag = `"drive-version-${++this.sequence}"`;
    file.modifiedTime = new Date().toISOString();
    this.successfulConditionalWrites += 1;
    await route.fulfill({ status: 200, contentType: "application/json", headers: googleHeaders({ etag: file.etag }), body: JSON.stringify({ id }) });
  }

  private async media(route: Route, id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) { await route.fulfill({ status: 404, headers: googleHeaders() }); return; }
    const range = /^bytes=(\d+)-(\d+)$/u.exec(route.request().headers()["range"] ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const bytes = file.bytes.subarray(start, end + 1);
      this.rangeReads += 1;
      await route.fulfill({ status: 206, headers: googleHeaders({ etag: file.etag, "content-length": String(bytes.length), "content-range": `bytes ${start}-${end}/${file.bytes.length}` }), body: bytes });
      return;
    }
    await route.fulfill({ status: 200, headers: googleHeaders({ etag: file.etag, "content-length": String(file.bytes.length) }), body: file.bytes });
  }

  private insert(metadata: FileMetadata, bytes: Buffer): StoredFile {
    const id = `drive_acceptance_${++this.sequence}`;
    const file: StoredFile = {
      id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      parents: metadata.parents,
      appProperties: metadata.appProperties,
      bytes: Buffer.from(bytes),
      modifiedTime: new Date().toISOString(),
      etag: `"drive-version-${this.sequence}"`,
      text() { return this.bytes.toString("utf8"); },
    };
    this.files.set(id, file);
    return file;
  }

  private metadata(file: StoredFile): Record<string, unknown> {
    return { id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.bytes.length), modifiedTime: file.modifiedTime, appProperties: file.appProperties, webViewLink: `https://drive.google.com/drive/folders/${file.id}` };
  }
}

type FileMetadata = { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };

function googleHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // The same boundary runs under the ordinary 4173 matrix and the isolated
    // 4187 Drive contract. No cookies or browser credentials are involved.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type,if-match,range",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-expose-headers": "etag,content-length,content-range",
    ...extra,
  };
}
