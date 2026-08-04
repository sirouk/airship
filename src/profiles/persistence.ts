import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import {
  WorkspaceRootKey,
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from "../storage/encrypted-envelope";
import type { ObjectRecord, ObjectStore } from "../storage/object-store";
import { managedProfileRevisions, type ProfileCatalog } from "./catalog";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  createSkillRevision,
  createThemeManifest,
  MAX_CATALOG_SKILLS,
  type ProfileRevision,
  type SkillRevision,
  type ThemeManifest,
} from "./domain";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CATALOG_NAMESPACE = "airship/profile-catalog/v1";
const CATALOG_LOGICAL_ID = "active-profile-catalog";
const CATALOG_CONTENT_TYPE = "application/vnd.airship.profile-catalog+json";
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_PROFILES = 1_024;
const MAX_THEMES = 256;

type PersistedCatalogHead = Readonly<{
  version: 1;
  generation: number;
  previousDigest: string | null;
  catalogDigest: string;
  catalog: ProfileCatalog;
}>;

export type ProfileCatalogCheckpoint = Readonly<{
  generation: number;
  digest: string;
  catalog: ProfileCatalog;
  /** Opaque adapter revision used only for conditional writes. */
  versionTag: string;
}>;

export type ProfileCatalogInitialization = Readonly<{
  checkpoint: ProfileCatalogCheckpoint;
  disposition: "created" | "existing";
}>;

/** Provider-neutral catalog authority. Implementations must reject stale writes. */
export interface ProfileCatalogStore {
  readonly durability: "ephemeral" | "encrypted-vault";
  load(signal?: AbortSignal): Promise<ProfileCatalogCheckpoint | undefined>;
  initialize(catalog: ProfileCatalog, signal?: AbortSignal): Promise<ProfileCatalogInitialization>;
  commit(
    expected: ProfileCatalogCheckpoint,
    catalog: ProfileCatalog,
    signal?: AbortSignal,
  ): Promise<ProfileCatalogCheckpoint>;
}

export class ProfileCatalogConflictError extends Error {
  constructor(message = "The profile catalog changed before this revision could be committed.") {
    super(message);
    this.name = "ProfileCatalogConflictError";
  }
}

/** Page-lifetime authority. It deliberately has no browser persistence side channel. */
export class MemoryProfileCatalogStore implements ProfileCatalogStore {
  readonly durability = "ephemeral" as const;
  private checkpoint?: ProfileCatalogCheckpoint;

  async load(): Promise<ProfileCatalogCheckpoint | undefined> {
    return this.checkpoint;
  }

  async initialize(catalog: ProfileCatalog): Promise<ProfileCatalogInitialization> {
    if (this.checkpoint) return Object.freeze({ checkpoint: this.checkpoint, disposition: "existing" });
    const normalized = await validateProfileCatalog(catalog);
    const digest = await profileCatalogDigest(normalized);
    this.checkpoint = checkpoint(1, digest, normalized, memoryVersionTag(1, digest));
    return Object.freeze({ checkpoint: this.checkpoint, disposition: "created" });
  }

  async commit(expected: ProfileCatalogCheckpoint, catalog: ProfileCatalog): Promise<ProfileCatalogCheckpoint> {
    const current = this.checkpoint;
    if (!current || !sameCheckpoint(current, expected)) throw new ProfileCatalogConflictError();
    const normalized = await validateProfileCatalog(catalog);
    const digest = await profileCatalogDigest(normalized);
    const generation = current.generation + 1;
    this.checkpoint = checkpoint(generation, digest, normalized, memoryVersionTag(generation, digest));
    return this.checkpoint;
  }
}

/**
 * One encrypted CAS head over any conforming ObjectStore (S3, Drive, or a test
 * adapter). Provider credentials and the root key remain outside this class.
 */
export class EncryptedProfileCatalogStore implements ProfileCatalogStore {
  readonly durability = "encrypted-vault" as const;
  private readonly prefix: string;

  constructor(
    private readonly store: ObjectStore,
    private readonly key: WorkspaceRootKey,
    prefix = "state/profiles/v1",
  ) {
    this.prefix = normalizePrefix(prefix);
  }

  async load(signal?: AbortSignal): Promise<ProfileCatalogCheckpoint | undefined> {
    const record = await this.store.get(await this.cloudKey(), signal);
    return record ? this.openRecord(record) : undefined;
  }

  async initialize(catalog: ProfileCatalog, signal?: AbortSignal): Promise<ProfileCatalogInitialization> {
    const normalized = await validateProfileCatalog(catalog);
    const digest = await profileCatalogDigest(normalized);
    const head: PersistedCatalogHead = Object.freeze({
      version: 1,
      generation: 1,
      previousDigest: null,
      catalogDigest: digest,
      catalog: normalized,
    });
    const bytes = await this.sealHead(head);
    const result = await this.store.putIfAbsent(await this.cloudKey(), bytes, signal);
    if (result.created) {
      return Object.freeze({
        checkpoint: checkpoint(1, digest, normalized, result.etag),
        disposition: "created",
      });
    }
    const existing = await this.load(signal);
    if (!existing) throw new ProfileCatalogConflictError("The profile catalog was created concurrently and then disappeared.");
    return Object.freeze({ checkpoint: existing, disposition: "existing" });
  }

  async commit(
    expected: ProfileCatalogCheckpoint,
    catalog: ProfileCatalog,
    signal?: AbortSignal,
  ): Promise<ProfileCatalogCheckpoint> {
    if (!Number.isSafeInteger(expected.generation) || expected.generation < 1 || !expected.versionTag) {
      throw new ProfileCatalogConflictError("The expected profile catalog generation is invalid.");
    }
    const expectedCatalog = await validateProfileCatalog(expected.catalog);
    if (await profileCatalogDigest(expectedCatalog) !== expected.digest) {
      throw new ProfileCatalogConflictError("The expected profile catalog digest is invalid.");
    }
    const normalized = await validateProfileCatalog(catalog);
    const digest = await profileCatalogDigest(normalized);
    const generation = expected.generation + 1;
    const head: PersistedCatalogHead = Object.freeze({
      version: 1,
      generation,
      previousDigest: expected.digest,
      catalogDigest: digest,
      catalog: normalized,
    });
    const bytes = await this.sealHead(head);
    const result = await this.store.compareAndSwap(
      await this.cloudKey(),
      expected.versionTag,
      bytes,
      signal,
    );
    if (!result.updated) throw new ProfileCatalogConflictError();
    return checkpoint(generation, digest, normalized, result.etag);
  }

  private async cloudKey(): Promise<string> {
    return `${this.prefix}/catalog-head/${await this.key.opaqueObjectId(CATALOG_LOGICAL_ID)}`;
  }

  private async sealHead(head: PersistedCatalogHead): Promise<Uint8Array> {
    const plaintext = encoder.encode(stableStringify(head as unknown as JsonValue));
    if (plaintext.byteLength > MAX_CATALOG_BYTES) throw new Error("The profile catalog exceeds the encrypted storage limit.");
    return encodeEnvelope(await sealEnvelope({
      key: this.key,
      namespace: CATALOG_NAMESPACE,
      logicalId: CATALOG_LOGICAL_ID,
      revision: revisionFor(head.generation, head.catalogDigest),
      contentType: CATALOG_CONTENT_TYPE,
      plaintext,
    }));
  }

  private async openRecord(record: ObjectRecord): Promise<ProfileCatalogCheckpoint> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: CATALOG_NAMESPACE,
      expectedLogicalId: CATALOG_LOGICAL_ID,
      maxPlaintextBytes: MAX_CATALOG_BYTES,
    });
    const head = await parsePersistedHead(plaintext);
    if (
      envelope.aad.contentType !== CATALOG_CONTENT_TYPE
      || envelope.revision !== revisionFor(head.generation, head.catalogDigest)
      || record.key !== await this.cloudKey()
    ) {
      throw new Error("Encrypted profile catalog metadata does not match its contents.");
    }
    return checkpoint(head.generation, head.catalogDigest, head.catalog, record.etag);
  }
}

export async function profileCatalogDigest(catalog: ProfileCatalog): Promise<string> {
  return sha256(stableStringify(catalog as unknown as JsonValue));
}

/**
 * The Boundary Record's own rule, checked before a byte of a hostile seed is
 * rebuilt: the three keys that walk a prototype if spread blindly. Only own
 * properties count (everything here arrived through JSON.parse) and the walk
 * is depth-bounded, because a validator that can be pushed into an infinite
 * descent is itself a load amplifier. A catalog that survives this carries no
 * `__proto__` anywhere the rebuild is about to trust.
 */
function rejectPoisonKeys(value: unknown, depth = 0): void {
  // The deepest shape this record owns is roughly five levels; 24 is the same
  // fail-closed posture the billing payload walk takes, not a guess at it.
  if (depth > 24) throw new Error("Profile catalog exceeds its structural depth.");
  if (!isRecord(value)) return;
  for (const key of ["__proto__", "prototype", "constructor"] as const) {
    if (Object.hasOwn(value, key)) {
      throw new Error("Profile catalog contains a forbidden object key.");
    }
  }
  for (const item of Object.values(value)) rejectPoisonKeys(item, depth + 1);
}

/** Rebuilds every content-addressed member and drops unrecognized JSON keys. */
export async function validateProfileCatalog(value: unknown): Promise<ProfileCatalog> {
  if (!isRecord(value)) throw new Error("Profile catalog must be a JSON object.");
  rejectPoisonKeys(value);
  const themeValues = boundedArray(value.themes, MAX_THEMES, "themes");
  // `MAX_CATALOG_SKILLS`, not a second local ceiling: this admission bound used
  // to sit at 1_024 while `domain.ts` refused above 512, so a catalog between
  // the two validated, persisted, and then failed every session resolution.
  const skillValues = boundedArray(value.skills, MAX_CATALOG_SKILLS, "skills");
  const profileValues = boundedArray(value.profiles, MAX_PROFILES, "profiles");
  if (profileValues.length === 0) throw new Error("Profile catalog must contain at least one profile.");

  const themes = await Promise.all(themeValues.map(async (candidate) => {
    if (!isRecord(candidate) || typeof candidate.digest !== "string") throw new Error("Profile catalog theme is invalid.");
    const rebuilt = await createThemeManifest(candidate as unknown as ThemeManifest);
    if (rebuilt.digest !== candidate.digest) throw new Error(`Theme ${rebuilt.themeId} failed its content-digest check.`);
    return rebuilt;
  }));
  const skills = await Promise.all(skillValues.map(async (candidate) => {
    if (!isRecord(candidate) || typeof candidate.digest !== "string") throw new Error("Profile catalog skill is invalid.");
    const rebuilt = await createSkillRevision(candidate as unknown as SkillRevision);
    if (rebuilt.digest !== candidate.digest) throw new Error(`Skill ${rebuilt.skillId} failed its content-digest check.`);
    return rebuilt;
  }));
  const profiles = await Promise.all(profileValues.map(async (candidate) => {
    if (!isRecord(candidate) || typeof candidate.revision !== "string") throw new Error("Profile catalog revision is invalid.");
    const rebuilt = await createProfileRevision(candidate as unknown as ProfileRevision);
    if (rebuilt.revision !== candidate.revision) throw new Error(`Profile ${rebuilt.profileId} failed its revision check.`);
    return rebuilt;
  }));

  assertUnique(themes.map((theme) => theme.themeId), "theme ID");
  assertUnique(skills.map((skill) => skill.skillId), "skill ID");
  assertUnique(profiles.map((profile) => profile.profileId), "profile ID");
  const themePins = new Set(themes.map((theme) => `${theme.themeId}\0${theme.digest}`));
  const skillIds = new Set(skills.map((skill) => skill.skillId));
  for (const profile of profiles) {
    if (!themePins.has(`${profile.theme.themeId}\0${profile.theme.digest}`)) {
      throw new Error(`Profile ${profile.profileId} references an unavailable theme revision.`);
    }
    for (const skillId of Object.keys(profile.skillModes)) {
      if (!skillIds.has(skillId)) throw new Error(`Profile ${profile.profileId} references missing skill ${skillId}.`);
    }
  }

  if (!isRecord(value.globalSkills)) throw new Error("Profile catalog global skill settings are invalid.");
  const globalSkills = createGlobalSkillSettings(value.globalSkills as Readonly<Record<string, boolean>>);
  for (const skillId of Object.keys(globalSkills)) {
    if (!skillIds.has(skillId)) throw new Error(`Global settings reference missing skill ${skillId}.`);
  }
  const archivedProfileIds = value.archivedProfileIds === undefined
    ? []
    : boundedArray(value.archivedProfileIds, MAX_PROFILES, "archived profile IDs").map((candidate) => {
        if (typeof candidate !== "string") throw new Error("Archived profile ID is invalid.");
        return candidate;
      });
  assertUnique(archivedProfileIds, "archived profile ID");
  const profileIds = new Set(profiles.map((profile) => profile.profileId));
  for (const profileId of archivedProfileIds) {
    if (!profileIds.has(profileId)) throw new Error(`Archived profile ${profileId} has no retained revision.`);
  }

  const catalog: ProfileCatalog = Object.freeze({
    themes: Object.freeze(themes),
    skills: Object.freeze(skills),
    profiles: Object.freeze(profiles),
    archivedProfileIds: Object.freeze(archivedProfileIds),
    globalSkills,
  });
  if (managedProfileRevisions(catalog).length === 0) throw new Error("Profile catalog must retain one profile for new work.");
  return catalog;
}

async function parsePersistedHead(bytes: Uint8Array): Promise<PersistedCatalogHead> {
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error("Encrypted profile catalog exceeds the configured limit.");
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (
    !isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || (value.previousDigest !== null && !isDigest(value.previousDigest))
    || !isDigest(value.catalogDigest)
  ) {
    throw new Error("Encrypted profile catalog head is invalid.");
  }
  if ((value.generation === 1) !== (value.previousDigest === null)) {
    throw new Error("Encrypted profile catalog generation ancestry is invalid.");
  }
  const catalog = await validateProfileCatalog(value.catalog);
  const digest = await profileCatalogDigest(catalog);
  if (digest !== value.catalogDigest) throw new Error("Encrypted profile catalog digest does not match its contents.");
  return Object.freeze({
    version: 1,
    generation: value.generation as number,
    previousDigest: value.previousDigest as string | null,
    catalogDigest: digest,
    catalog,
  });
}

function checkpoint(
  generation: number,
  digest: string,
  catalog: ProfileCatalog,
  versionTag: string,
): ProfileCatalogCheckpoint {
  return Object.freeze({ generation, digest, catalog, versionTag });
}

function sameCheckpoint(left: ProfileCatalogCheckpoint, right: ProfileCatalogCheckpoint): boolean {
  return left.generation === right.generation
    && left.digest === right.digest
    && left.versionTag === right.versionTag;
}

function memoryVersionTag(generation: number, digest: string): string {
  return `memory:${generation}:${digest}`;
}

function revisionFor(generation: number, digest: string): string {
  return `${generation}:${digest}`;
}

function normalizePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!normalized || /(?:^|\/)\.\.(?:\/|$)/u.test(normalized)) throw new Error("Profile catalog prefix is invalid.");
  return normalized;
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Profile catalog ${label} are invalid.`);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Profile catalog contains a duplicate ${label}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[A-Za-z0-9_-]{43}$/u.test(value);
}
