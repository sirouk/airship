import { loadPyodide } from "pyodide";

const N_BOOT = 3;
const N_JOBS = 10;

async function bootOnce() {
  const t0 = performance.now();
  const py = await loadPyodide({ indexURL: undefined });
  const t1 = performance.now();
  try { await py.runPythonAsync("import sys\nassert sys.version_info.major == 3"); } catch {}
  const t2 = performance.now();
  return { bootMs: t1 - t0, probeMs: t2 - t1 };
}

async function persistentJobs(py, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await py.runPythonAsync(`x = ${i} + 1\nx * 2`);
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  return times;
}

async function main() {
  const boots = [];
  for (let i = 0; i < N_BOOT; i++) {
    const b = await bootOnce();
    boots.push(b);
    console.log(`boot ${i}: total=${(b.bootMs + b.probeMs).toFixed(0)}ms init=${b.bootMs.toFixed(0)}ms probe=${b.probeMs.toFixed(0)}ms`);
  }
  const py = await loadPyodide();
  const times = await persistentJobs(py, N_JOBS);
  console.log(`persistent roundtrips (n=${N_JOBS}): ${times.map(t => t.toFixed(1)).join(", ")} ms`);
  const avgBoot = boots.reduce((s, b) => s + b.bootMs + b.probeMs, 0) / boots.length;
  console.log(`mean boot: ${avgBoot.toFixed(0)}ms`);
  console.log(`disposable per-job total at ${N_JOBS} jobs: ${(avgBoot * N_JOBS / 1000).toFixed(1)}s; persistent total: ${((boots[0].bootMs + boots[0].probeMs)/1000).toFixed(1)}s + ${times.reduce((a,b)=>a+b,0).toFixed(0)}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
