import { useEffect, useRef, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import { RecoveryKeyGroups } from "./google-drive-setup";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import type { ConfigureVaultRequest } from "../vault/coordinator";
import type { LocalLabRecoveryMaterial } from "../vault/local-lab";
import "./local-lab-setup.css";

export type LocalLabSetupProps = {
  onConfigure(request: ConfigureVaultRequest): void;
};

export const LOCAL_LAB_DEFAULT_ENDPOINT = "http://127.0.0.1:9900";
const LOCAL_LAB_FIXTURE = Object.freeze({
  region: "us-east-1",
  bucket: "airship-dev",
  namespace: "airship-live-v2/local-user",
  accessKeyId: "airship-vault-probe",
  secretAccessKey: "airship-vault-probe-only-2026",
});

export const LOCAL_LAB_FIELDS = Object.freeze([
  "endpoint", "region", "bucket", "namespace", "accessKeyId", "secretAccessKey",
] as const);

export type LocalLabField = (typeof LOCAL_LAB_FIELDS)[number];

type FieldErrors = Readonly<Partial<Record<LocalLabField, string>>>;

const NO_FIELD_ERRORS: FieldErrors = Object.freeze({});

const LOCAL_LAB_FIELD_LABELS: Readonly<Record<LocalLabField, string>> = Object.freeze({
  endpoint: "Endpoint",
  region: "Region",
  bucket: "Bucket",
  namespace: "Private namespace",
  accessKeyId: "Access key",
  secretAccessKey: "Secret key",
});

/**
 * Anchor a refused configuration to the field that caused it.
 *
 * The coordinator raises one sentence for the whole form. Until it carries a
 * field code, this maps its own wording to the input it is about — and returns
 * nothing when it cannot, so an unmatched refusal keeps its summary rather than
 * being pinned to a guessed field.
 */
export function localLabFieldForError(message: string): LocalLabField | undefined {
  const text = message.toLocaleLowerCase();
  if (/loopback|localhost|127\.0\.0\.1|::1|endpoint|https?/u.test(text)) return "endpoint";
  if (/namespace|prefix/u.test(text)) return "namespace";
  if (/bucket/u.test(text)) return "bucket";
  if (/region/u.test(text)) return "region";
  if (/secret/u.test(text)) return "secretAccessKey";
  if (/access key/u.test(text)) return "accessKeyId";
  return undefined;
}

/** Loopback-only setup. It hands memory objects to the coordinator and never probes storage. */
function LocalLabSetupForm({ onConfigure }: LocalLabSetupProps) {
  const [endpoint, setEndpoint] = useState(LOCAL_LAB_DEFAULT_ENDPOINT);
  const [region, setRegion] = useState<string>(LOCAL_LAB_FIXTURE.region);
  const [bucket, setBucket] = useState<string>(LOCAL_LAB_FIXTURE.bucket);
  const [namespace, setNamespace] = useState<string>(LOCAL_LAB_FIXTURE.namespace);
  const [accessKeyId, setAccessKeyId] = useState<string>(LOCAL_LAB_FIXTURE.accessKeyId);
  const [secretAccessKey, setSecretAccessKey] = useState<string>(LOCAL_LAB_FIXTURE.secretAccessKey);
  const [recoveryMode, setRecoveryMode] = useState<"generate" | "import">("generate");
  const [recovery, setRecovery] = useState<LocalLabRecoveryMaterial>();
  const [importedRecovery, setImportedRecovery] = useState("");
  const [showImportedRecovery, setShowImportedRecovery] = useState(false);
  const recoveryRef = useRef<LocalLabRecoveryMaterial>();
  const recoveryGeneration = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [loopbackAcknowledged, setLoopbackAcknowledged] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "success"; message: string }>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const endpointField = useRef<HTMLInputElement>(null);
  const regionField = useRef<HTMLInputElement>(null);
  const bucketField = useRef<HTMLInputElement>(null);
  const namespaceField = useRef<HTMLInputElement>(null);
  const accessKeyField = useRef<HTMLInputElement>(null);
  const secretKeyField = useRef<HTMLInputElement>(null);
  const fieldRefs: Readonly<Record<LocalLabField, { current: HTMLInputElement | null }>> = {
    endpoint: endpointField,
    region: regionField,
    bucket: bucketField,
    namespace: namespaceField,
    accessKeyId: accessKeyField,
    secretAccessKey: secretKeyField,
  };
  const invalidFields = LOCAL_LAB_FIELDS.filter((field) => fieldErrors[field] !== undefined);

  const clearFieldError = (field: LocalLabField): void => {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return Object.freeze(next);
    });
  };

  useEffect(() => () => {
    recoveryGeneration.current += 1;
    recoveryRef.current?.clear();
  }, []);

  const generateRecovery = async () => {
    const generation = ++recoveryGeneration.current;
    setGenerating(true);
    setStatus(undefined);
    recoveryRef.current?.clear();
    setRecovery(undefined);
    setRecoveryAcknowledged(false);
    try {
      const { LocalLabRecoveryMaterial } = await loadDeferredCapabilities();
      const material = await LocalLabRecoveryMaterial.generate();
      if (generation !== recoveryGeneration.current) {
        material.clear();
        return;
      }
      recoveryRef.current = material;
      setRecovery(material);
    } catch {
      setStatus({ kind: "error", message: "This browser could not generate the WebCrypto workspace key." });
    } finally {
      if (generation === recoveryGeneration.current) setGenerating(false);
    }
  };

  const chooseRecoveryMode = (mode: "generate" | "import") => {
    recoveryGeneration.current += 1;
    recoveryRef.current?.clear();
    recoveryRef.current = undefined;
    setRecovery(undefined);
    setImportedRecovery("");
    setShowImportedRecovery(false);
    setRecoveryAcknowledged(false);
    setGenerating(false);
    setStatus(undefined);
    setRecoveryMode(mode);
  };

  const clearForm = () => {
    recoveryGeneration.current += 1;
    recoveryRef.current?.clear();
    recoveryRef.current = undefined;
    setRecovery(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
    setRecoveryMode("generate");
    setImportedRecovery("");
    setShowImportedRecovery(false);
    setRecoveryAcknowledged(false);
    setLoopbackAcknowledged(false);
    setEndpoint("");
    setRegion("");
    setBucket("");
    setNamespace("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setGenerating(false);
    setHandingOff(false);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (handingOff) return;
    setHandingOff(true);
    setStatus(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
    if ((recoveryMode === "generate" && !recovery) || (recoveryMode === "import" && !importedRecovery.trim())) {
      setHandingOff(false);
      setStatus({ kind: "error", message: recoveryMode === "generate"
        ? "Generate and save a recovery key before configuring the lab."
        : "Enter an existing Airship recovery key before configuring the lab." });
      return;
    }
    if (!recoveryAcknowledged || !loopbackAcknowledged) {
      setHandingOff(false);
      setStatus({ kind: "error", message: "Both local-only and recovery-key acknowledgements are required." });
      return;
    }
    let request: ConfigureVaultRequest;
    try {
      const { createLocalLabConfigureRequest, importLocalLabRecoveryKey } = await loadDeferredCapabilities();
      const workspaceKey: WorkspaceRootKey = recoveryMode === "generate"
        ? recovery!.workspaceKey
        : await importLocalLabRecoveryKey(importedRecovery);
      request = createLocalLabConfigureRequest({
        endpoint,
        region,
        bucket,
        namespace,
        accessKeyId,
        secretAccessKey,
        workspaceKey,
        recoveryKeySavedAcknowledged: recoveryAcknowledged,
        ownLoopbackServiceAcknowledged: loopbackAcknowledged,
      });
    } catch (error) {
      const message = error instanceof Error && (
        error.name === "VaultConfigurationError" || error.message.startsWith("Airship recovery key")
      )
        ? error.message
        : "The local lab handoff was refused. Recheck the loopback configuration and acknowledgements.";
      // A refused configuration is a correction, not a reset. Wiping six fields
      // and destroying the one-time recovery key the user was just told to save
      // is a worse outcome than the mistake being reported. The post-handoff
      // clearForm() below still covers the secret-hygiene case.
      const field = localLabFieldForError(message);
      setFieldErrors(field ? Object.freeze({ [field]: message }) : NO_FIELD_ERRORS);
      setHandingOff(false);
      setStatus({ kind: "error", message });
      if (field) {
        const input = fieldRefs[field].current;
        input?.scrollIntoView({ block: "center" });
        input?.focus();
      }
      return;
    }
    // The request owns the key/provider references now; clear DOM/component
    // secret state before a callback can synchronously replace this view.
    clearForm();
    try {
      onConfigure(request);
    } catch {
      request.credentialProvider.reset?.();
      setStatus({ kind: "error", message: "The vault coordinator refused the local lab handoff. All form secrets were cleared." });
      return;
    }
    setStatus({
      kind: "success",
      message: "Local lab configuration handed to the in-memory vault coordinator. No probe or storage write was run.",
    });
  };

  return (
    <section class="local-lab" aria-labelledby="local-lab-heading">
      <header class="local-lab__header">
        <div>
          <p class="local-lab__eyebrow">Development harness</p>
          <h2 id="local-lab-heading">Connect your loopback S3 lab</h2>
        </div>
        <span>Memory only</span>
      </header>

      <div class="local-lab__boundary" id="local-lab-boundary">
        <strong>Not a production credential path</strong>
        <p>
          Use disposable credentials belonging only to an S3-compatible service on this device.
          Never paste AWS, cloud-account, team, public-wallet, or shared service keys here.
        </p>
      </div>

      <form class="local-lab__form" autoComplete="off" onSubmit={submit} aria-describedby="local-lab-boundary">
        <fieldset>
          <legend>Loopback object store</legend>
          <label class="local-lab__wide" data-invalid={fieldErrors.endpoint ? "true" : "false"}>
            <span>Endpoint</span>
            <input
              ref={endpointField}
              type="url"
              name="airship-local-endpoint"
              value={endpoint}
              onInput={(event) => { setEndpoint(event.currentTarget.value); clearFieldError("endpoint"); }}
              placeholder={LOCAL_LAB_DEFAULT_ENDPOINT}
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              aria-invalid={fieldErrors.endpoint ? "true" : undefined}
              aria-describedby="local-lab-endpoint-hint"
              required
            />
            {/* The neutral hint is replaced by the refusal while invalid, so
                one line at one place answers "what should this say". */}
            <small id="local-lab-endpoint-hint" class={fieldErrors.endpoint ? "local-lab__field-error" : undefined}>
              {fieldErrors.endpoint
                ? `${fieldErrors.endpoint} Use localhost, 127.0.0.1, or [::1]. This is a loopback-only development lab.`
                : "Only localhost, 127.0.0.1, or [::1] is accepted. Path-style access is forced."}
            </small>
          </label>
          <label data-invalid={fieldErrors.region ? "true" : "false"}>
            <span>Region</span>
            <input
              ref={regionField}
              name="airship-local-region"
              value={region}
              onInput={(event) => { setRegion(event.currentTarget.value); clearFieldError("region"); }}
              placeholder="auto"
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              aria-invalid={fieldErrors.region ? "true" : undefined}
              aria-describedby={fieldErrors.region ? "local-lab-region-error" : undefined}
              required
            />
            {fieldErrors.region ? <small id="local-lab-region-error" class="local-lab__field-error">{fieldErrors.region}</small> : null}
          </label>
          <label data-invalid={fieldErrors.bucket ? "true" : "false"}>
            <span>Bucket</span>
            <input
              ref={bucketField}
              name="airship-local-bucket"
              value={bucket}
              onInput={(event) => { setBucket(event.currentTarget.value); clearFieldError("bucket"); }}
              placeholder="airship-dev"
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              aria-invalid={fieldErrors.bucket ? "true" : undefined}
              aria-describedby={fieldErrors.bucket ? "local-lab-bucket-error" : undefined}
              required
            />
            {fieldErrors.bucket ? <small id="local-lab-bucket-error" class="local-lab__field-error">{fieldErrors.bucket}</small> : null}
          </label>
          <label class="local-lab__wide" data-invalid={fieldErrors.namespace ? "true" : "false"}>
            <span>Private namespace</span>
            <input
              ref={namespaceField}
              name="airship-local-namespace"
              value={namespace}
              onInput={(event) => { setNamespace(event.currentTarget.value); clearFieldError("namespace"); }}
              placeholder="users/local-test"
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              aria-invalid={fieldErrors.namespace ? "true" : undefined}
              aria-describedby={fieldErrors.namespace ? "local-lab-namespace-error" : undefined}
              required
            />
            {fieldErrors.namespace ? <small id="local-lab-namespace-error" class="local-lab__field-error">{fieldErrors.namespace}</small> : null}
          </label>
        </fieldset>

        <fieldset>
          <legend>Disposable local credentials</legend>
          <label data-invalid={fieldErrors.accessKeyId ? "true" : "false"}>
            <span>Access key</span>
            <input
              ref={accessKeyField}
              value={accessKeyId}
              onInput={(event) => { setAccessKeyId(event.currentTarget.value); clearFieldError("accessKeyId"); }}
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              aria-invalid={fieldErrors.accessKeyId ? "true" : undefined}
              aria-describedby={fieldErrors.accessKeyId ? "local-lab-access-error" : undefined}
              required
            />
            {fieldErrors.accessKeyId ? <small id="local-lab-access-error" class="local-lab__field-error">{fieldErrors.accessKeyId}</small> : null}
          </label>
          <label data-invalid={fieldErrors.secretAccessKey ? "true" : "false"}>
            <span>Secret key</span>
            <input
              ref={secretKeyField}
              type="password"
              value={secretAccessKey}
              onInput={(event) => { setSecretAccessKey(event.currentTarget.value); clearFieldError("secretAccessKey"); }}
              autoComplete="new-password"
              autoCapitalize="none"
              spellcheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              aria-invalid={fieldErrors.secretAccessKey ? "true" : undefined}
              aria-describedby={fieldErrors.secretAccessKey ? "local-lab-secret-error" : undefined}
              required
            />
            {fieldErrors.secretAccessKey ? <small id="local-lab-secret-error" class="local-lab__field-error">{fieldErrors.secretAccessKey}</small> : null}
          </label>
          <p class="local-lab__wide local-lab__note">
            These values remain in page memory only. The form clears after handoff; disconnecting the vault calls the provider reset hook.
          </p>
        </fieldset>

        <fieldset>
          <legend>Workspace recovery key</legend>
          <div class="local-lab__mode local-lab__wide" role="group" aria-label="Recovery key source">
            <button
              type="button"
              class={recoveryMode === "generate" ? "local-lab__mode-active" : ""}
              aria-pressed={recoveryMode === "generate"}
              onClick={() => chooseRecoveryMode("generate")}
              disabled={handingOff}
            >
              Generate new
            </button>
            <button
              type="button"
              class={recoveryMode === "import" ? "local-lab__mode-active" : ""}
              aria-pressed={recoveryMode === "import"}
              onClick={() => chooseRecoveryMode("import")}
              disabled={handingOff}
            >
              Import existing
            </button>
          </div>
          {recoveryMode === "generate" ? (
            !recovery ? (
              <button type="button" class="local-lab__secondary" onClick={() => void generateRecovery()} disabled={generating || handingOff}>
                {generating ? "Generating…" : "Generate one-time recovery key"}
              </button>
            ) : (
              <div class="local-lab__recovery">
                <label>
                  <span>Save this now</span>
                  {/* Same 4-character grid as the other two provider panels;
                      grouping is layout, so the value stays exact. */}
                  <output
                    aria-label="One-time loopback lab recovery key"
                    aria-describedby="local-lab-recovery-warning"
                  >
                    <RecoveryKeyGroups value={recovery.displayValue} />
                  </output>
                </label>
                <p id="local-lab-recovery-warning">
                  Airship does not upload or persist this recovery key. Losing it means losing access to encrypted lab data.
                  Clipboard and password-manager behavior are outside Airship's control.
                </p>
                <button type="button" class="local-lab__quiet" onClick={() => void generateRecovery()} disabled={generating || handingOff}>
                  Replace key
                </button>
              </div>
            )
          ) : (
            <div class="local-lab__recovery">
              <label>
                <span>Existing Airship recovery key</span>
                <textarea
                  class={showImportedRecovery ? "" : "local-lab__masked"}
                  value={importedRecovery}
                  onInput={(event) => {
                    setImportedRecovery(event.currentTarget.value.slice(0, 128));
                    setRecoveryAcknowledged(false);
                  }}
                  rows={3}
                  maxLength={128}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellcheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  aria-describedby="local-lab-import-warning"
                  placeholder="airship-wrk-v1.…"
                  required
                />
              </label>
              <p id="local-lab-import-warning">
                Accepted only in the versioned Airship recovery format. The value stays in component memory and is cleared before coordinator handoff.
                Masking is visual defense-in-depth; password managers and browser extensions remain outside Airship's control.
              </p>
              <label class="local-lab__reveal">
                <input
                  type="checkbox"
                  checked={showImportedRecovery}
                  onChange={(event) => setShowImportedRecovery(event.currentTarget.checked)}
                />
                <span>Show imported recovery key</span>
              </label>
            </div>
          )}
        </fieldset>

        <div class="local-lab__acknowledgements">
          <p class="local-lab__eyebrow">Before handoff</p>
          <label>
            <input
              type="checkbox"
              checked={loopbackAcknowledged}
              onChange={(event) => setLoopbackAcknowledged(event.currentTarget.checked)}
            />
            <span>I own this loopback service and these are disposable local credentials—not production or shared keys.</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={recoveryAcknowledged}
              onChange={(event) => setRecoveryAcknowledged(event.currentTarget.checked)}
              disabled={recoveryMode === "generate" ? !recovery : !importedRecovery.trim()}
            />
            <span>{recoveryMode === "generate"
              ? "I saved the generated recovery key outside this page and understand it cannot be recovered by Airship."
              : "I verified this imported recovery key and understand Airship will clear the form but cannot recover the key for me."}</span>
          </label>
        </div>

        {status && <p class={`local-lab__status local-lab__status--${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>{status.message}</p>}

        {invalidFields.length > 0 ? (
          <p class="local-lab__status local-lab__status--error">
            {`Fix ${invalidFields.length} field${invalidFields.length === 1 ? "" : "s"} to continue — `}
            <button type="button" class="local-lab__link" onClick={() => {
              const field = invalidFields[0]!;
              const input = fieldRefs[field].current;
              input?.scrollIntoView({ block: "center" });
              input?.focus();
            }}>{invalidFields.map((field) => LOCAL_LAB_FIELD_LABELS[field]).join(", ")}</button>
          </p>
        ) : null}

        <div class="local-lab__actions">
          <button
            type="submit"
            disabled={
              handingOff ||
              (recoveryMode === "generate" ? !recovery : !importedRecovery.trim()) ||
              !recoveryAcknowledged ||
              !loopbackAcknowledged
            }
          >
            {handingOff ? "Validating in memory…" : "Hand off to memory-only vault"}
          </button>
          <button type="button" class="local-lab__quiet" onClick={() => { clearForm(); setStatus(undefined); }}>
            Clear form
          </button>
        </div>
        <p class="local-lab__footnote">Handoff validates configuration only. Run the separately acknowledged live probe from the Vault screen.</p>
      </form>
    </section>
  );
}

function ProductionLabBoundary() {
  return (
    <section class="local-lab" aria-labelledby="local-lab-heading">
      <header class="local-lab__header">
        <div>
          <p class="local-lab__eyebrow">Development harness</p>
          <h2 id="local-lab-heading">Loopback S3 is development-only</h2>
        </div>
        <span>Unavailable</span>
      </header>
      <div class="local-lab__boundary">
        <strong>No production credential path</strong>
        <p>Run Airship in local development mode to connect the disposable loopback S3 conformance lab.</p>
      </div>
    </section>
  );
}

// The reviewed production CSP cannot connect to loopback services. Keeping the
// credential form out of that build makes the shipped code match its boundary;
// Vite retains the full form for `npm run dev` and the local full-system suite.
export const LocalLabSetup = import.meta.env.DEV ? LocalLabSetupForm : ProductionLabBoundary;
