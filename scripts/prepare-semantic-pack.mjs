import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(".airship-lab/semantic-pack");
const manifest = JSON.parse(await readFile(new URL("../src/indexing/semantic-artifact-manifest.json", import.meta.url), "utf8"));
const modelPrefix = "models/mixedbread-ai/mxbai-embed-xsmall-v1/";
const upstream = `https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/${manifest.modelRevision}/`;

for (const [path, expected] of Object.entries(manifest.assets)) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  if (path.startsWith(modelPrefix)) {
    const response = await fetch(`${upstream}${path.slice(modelPrefix.length)}`, { redirect: "follow" });
    if (!response.ok) throw new Error(`Could not download ${path}: ${response.status}`);
    await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  } else if (path === "runtime/transformers.web.js") {
    await cp(resolve("node_modules/@huggingface/transformers/dist/transformers.web.js"), target);
  } else {
    await cp(resolve("node_modules/onnxruntime-web/dist", path.slice("runtime/".length)), target);
  }
  const bytes = await readFile(target);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`${path} does not match the reviewed semantic artifact manifest.`);
  }
  process.stdout.write(`verified ${path} (${bytes.byteLength} bytes)\n`);
}
