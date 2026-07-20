import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

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
    const source = await readFile(resolve("node_modules/@huggingface/transformers/dist/transformers.web.js"), "utf8");
    const webgpuSpecifier = 'from "onnxruntime-web/webgpu"';
    const commonSpecifier = 'from "onnxruntime-common"';
    if (!source.includes(webgpuSpecifier) || !source.includes(commonSpecifier)) throw new Error("The pinned Transformers.js ORT import contract changed.");
    await writeFile(target, source
      .replace(webgpuSpecifier, 'from "./ort.webgpu.bundle.min.mjs"')
      .replace(commonSpecifier, 'from "./onnxruntime-common.mjs"'));
  } else if (path === "runtime/ort.webgpu.bundle.min.mjs") {
    await cp(resolve("node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs"), target);
  } else if (path === "runtime/onnxruntime-common.mjs") {
    await build({
      entryPoints: [resolve("node_modules/onnxruntime-common/dist/esm/index.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      minify: true,
      outfile: target,
      logLevel: "silent",
    });
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
