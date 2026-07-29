#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = path.join(REPO_ROOT, "references/repositories.json");
const CHECKOUT_PREFIX = "references/checkouts/";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function validateCheckoutPath(value) {
  if (typeof value !== "string" || !value.startsWith(CHECKOUT_PREFIX)) {
    throw new Error(`Checkout path must start with ${CHECKOUT_PREFIX}`);
  }
  if (
    path.posix.isAbsolute(value)
    || value.includes("\\")
    || path.posix.normalize(value) !== value
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Checkout path is not a canonical confined path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.length !== 4 || !parts[3] || !["open-source", "source-available", "clean-room"].includes(parts[2])) {
    throw new Error(`Checkout path has an unsupported classification directory: ${value}`);
  }
  return value;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function confinedFile(checkout, relative) {
  if (typeof relative !== "string" || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative) {
    throw new Error(`Non-canonical catalogued file path: ${String(relative)}`);
  }
  const resolved = realpathSync(path.join(checkout, relative));
  const root = `${realpathSync(checkout)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`Catalogued file escapes checkout: ${relative}`);
  return resolved;
}

function validateManifestEntry(entry, ids, paths) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Reference entry must be an object.");
  for (const field of ["id", "name", "repositoryUrl", "cloneUrl", "classification", "studyMode", "sourceUse"]) {
    if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`Reference entry is missing ${field}.`);
  }
  if (ids.has(entry.id)) throw new Error(`Duplicate reference id: ${entry.id}`);
  ids.add(entry.id);
  validateCheckoutPath(entry.checkoutPath);
  if (paths.has(entry.checkoutPath)) throw new Error(`Duplicate checkout path: ${entry.checkoutPath}`);
  paths.add(entry.checkoutPath);
  if (!SHA1.test(entry.revision) || !SHA1.test(entry.treeRevision)) throw new Error(`${entry.id} has an invalid commit or tree revision.`);
  if (/implementation/u.test(entry.studyMode)) throw new Error(`${entry.id} studyMode weakens the idea-level clean-room boundary.`);
  if (entry.licenseFile === null) {
    if (entry.licenseSha256 !== null) throw new Error(`${entry.id} has a license hash without a license file.`);
  } else if (typeof entry.licenseFile !== "string" || !SHA256.test(entry.licenseSha256)) {
    throw new Error(`${entry.id} must pin a license file and SHA-256 hash.`);
  }
  if (entry.classification === "clean-room-public-source") {
    if (typeof entry.parentRepositoryUrl !== "string" || !SHA1.test(entry.parentRevision)) {
      throw new Error(`${entry.id} must pin its parent repository and revision.`);
    }
    if (entry.sourceUse !== "no-source-reuse") throw new Error(`${entry.id} must retain the absolute no-source-reuse boundary.`);
  }
}

function verifyCheckout(entry, strict) {
  const target = path.join(REPO_ROOT, entry.checkoutPath);
  if (!existsSync(target)) {
    if (strict) throw new Error(`Missing required checkout: ${entry.checkoutPath}`);
    return false;
  }
  if (lstatSync(target).isSymbolicLink()) throw new Error(`Checkout target may not be a symlink: ${entry.checkoutPath}`);
  const checkoutRoot = realpathSync(path.join(REPO_ROOT, "references/checkouts"));
  const realTarget = realpathSync(target);
  if (!realTarget.startsWith(`${checkoutRoot}${path.sep}`)) throw new Error(`Checkout resolves outside the library: ${entry.checkoutPath}`);
  if (!lstatSync(path.join(realTarget, ".git")).isDirectory()) throw new Error(`Checkout is not a standalone Git worktree: ${entry.checkoutPath}`);

  const at = (...args) => git(["-C", realTarget, ...args]);
  if (at("rev-parse", "HEAD") !== entry.revision) throw new Error(`${entry.id} HEAD does not match the catalog.`);
  if (at("rev-parse", "HEAD^{tree}") !== entry.treeRevision) throw new Error(`${entry.id} tree does not match the catalog.`);
  const attached = spawnSync("git", ["-C", realTarget, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" });
  if (attached.status === 0) throw new Error(`${entry.id} must remain detached.`);
  if (at("status", "--porcelain", "--untracked-files=all")) throw new Error(`${entry.id} checkout is dirty.`);
  if (at("config", "--get", "core.hooksPath") !== "/dev/null") throw new Error(`${entry.id} hooks are not disabled.`);

  if (entry.licenseFile === null) {
    const rootLicenses = readdirSync(realTarget).filter((name) => /^(?:licen[cs]e|copying)(?:\.|$)/iu.test(name));
    if (rootLicenses.length) throw new Error(`${entry.id} now has root license evidence; update the catalog before study.`);
  } else {
    const license = confinedFile(realTarget, entry.licenseFile);
    if (sha256(license) !== entry.licenseSha256) throw new Error(`${entry.id} license evidence changed.`);
  }
  for (const evidence of entry.licenseHistory ?? []) {
    if (!evidence || typeof evidence.file !== "string" || !SHA256.test(evidence.sha256)) throw new Error(`${entry.id} has malformed license-history evidence.`);
    if (sha256(confinedFile(realTarget, evidence.file)) !== evidence.sha256) throw new Error(`${entry.id} license-history evidence changed.`);
  }
  return true;
}

function verifyTrackedIsolation() {
  const tracked = git(["ls-files", "--", "references/checkouts"]);
  if (tracked) throw new Error(`Reference checkout content is tracked:\n${tracked}`);

  const candidates = git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((file) => file !== "scripts/check-reference-library.mjs")
    .filter((file) => /^(?:src|e2e|extension|public|\.github\/workflows|scripts)\//u.test(file)
      || /^(?:package\.json|vite\.config\.ts|tsconfig[^/]*\.json|playwright[^/]*\.ts)$/u.test(file));
  const leaks = candidates.filter((file) => readFileSync(path.join(REPO_ROOT, file), "utf8").includes(CHECKOUT_PREFIX));
  if (leaks.length) throw new Error(`Build, test, fixture, or release inputs reference checkout paths:\n${leaks.join("\n")}`);

  const packageManifest = readJson(path.join(REPO_ROOT, "package.json"));
  for (const scriptName of ["test", "test:watch"]) {
    const command = packageManifest.scripts?.[scriptName];
    if (typeof command !== "string" || !/--exclude\s+['"]references\/\*\*['"]/u.test(command)) {
      throw new Error(`package.json ${scriptName} must exclude references/** so research code is never discovered or executed.`);
    }
  }
}

function verifyDecisionRecords(referenceIds) {
  const directory = path.join(REPO_ROOT, "references/decisions");
  if (!existsSync(directory)) throw new Error("Missing references/decisions provenance records.");
  const records = readdirSync(directory).filter((name) => name.endsWith(".json"));
  if (!records.length) throw new Error("No clean-room decision records exist.");
  for (const name of records) {
    const record = readJson(path.join(directory, name));
    if (record.schemaVersion !== 1 || typeof record.id !== "string" || !SHA1.test(record.airshipBaselineCommit)) {
      throw new Error(`${name} has an invalid decision-record identity or baseline.`);
    }
    for (const id of record.referenceIds ?? []) if (!referenceIds.has(id)) throw new Error(`${name} references unknown catalog id ${id}.`);
    for (const [field, prefix] of [["observation", "references/studies/"], ["specification", "references/specs/"]]) {
      const value = record[field];
      if (record.kind === "reference-informed-implementation" && typeof value !== "string") throw new Error(`${name} is missing ${field}.`);
      if (value !== null && value !== undefined) {
        if (typeof value !== "string" || !value.startsWith(prefix) || path.posix.normalize(value) !== value || !existsSync(path.join(REPO_ROOT, value))) {
          throw new Error(`${name} has an invalid ${field} link.`);
        }
      }
    }
    if (!record.result || !Array.isArray(record.result.paths) || typeof record.reviewVerdict !== "string") {
      throw new Error(`${name} is missing its result or review verdict.`);
    }
  }
}

export function verifyReferenceLibrary({ strict = false } = {}) {
  const manifest = readJson(MANIFEST_PATH);
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.repositories)) throw new Error("Unsupported reference catalog schema.");
  const ids = new Set();
  const paths = new Set();
  for (const entry of manifest.repositories) validateManifestEntry(entry, ids, paths);
  verifyTrackedIsolation();
  verifyDecisionRecords(ids);
  let hydrated = 0;
  for (const entry of manifest.repositories) if (verifyCheckout(entry, strict)) hydrated += 1;
  return Object.freeze({ catalogued: manifest.repositories.length, hydrated, strict });
}

function selfTest() {
  const accepted = "references/checkouts/clean-room/example--repo";
  if (validateCheckoutPath(accepted) !== accepted) throw new Error("Canonical path self-test failed.");
  for (const rejected of [
    "../references/checkouts/clean-room/repo",
    "references/checkouts/../outside",
    "references/checkouts/clean-room/../../outside",
    "references/checkouts/quarantine/repo",
    "/references/checkouts/clean-room/repo",
    "references\\checkouts\\clean-room\\repo",
  ]) {
    let failed = false;
    try { validateCheckoutPath(rejected); } catch { failed = true; }
    if (!failed) throw new Error(`Unsafe path passed self-test: ${rejected}`);
  }
  return 7;
}

function main() {
  if (process.argv.includes("--self-test")) {
    const assertions = selfTest();
    process.stdout.write(`Reference-path self-test passed (${assertions} assertions).\n`);
    return;
  }
  const result = verifyReferenceLibrary({ strict: process.argv.includes("--require-checkouts") });
  process.stdout.write(`Reference library verified: ${result.catalogued} catalogued, ${result.hydrated} hydrated${result.strict ? ", strict mode" : ""}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
