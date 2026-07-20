const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/node-webcontainer-pack-DEzqz2JI.js","assets/contracts-CZSAymJe.js"])))=>i.map(i=>d[i]);
import{t as e}from"./preload-helper-Czpn1I53.js";import{i as t,r as n}from"./contracts-CZSAymJe.js";var r=Object.freeze([{id:`python-pyodide`,label:`Python · Pyodide`,languages:[`python`],state:`installable`,isolation:`disposable-worker`,persistence:`ephemeral`,detail:`Optional pinned Pyodide pack; explicit cold install, fresh interpreter per job, bounded virtual workspace snapshots with optional revision-checked text writeback, standard library only, and no runtime network binding.`},{id:`wasix`,label:`WASIX toolchains`,languages:[`python`,`ruby`,`php`,`bash`,`compiled-wasm`],state:`unavailable`,isolation:`dedicated-worker`,persistence:`workspace-checkpoint`,detail:`Real WASIX Bash is documented upstream but is not bundled or installable here. Airship still needs pinned SDK/package artifacts, licenses, registry-origin policy, and a live browser probe; Git and Node are not assumed.`},{id:`node-webcontainer`,label:`Node.js · WebContainer`,languages:[`javascript`,`typescript`,`node`,`npm`],state:`installable`,isolation:`webcontainer`,persistence:`workspace-checkpoint`,detail:`Cold-loaded StackBlitz WebContainer pack; browser compute is local, while runtime delivery and npm egress use third-party services. Requires explicit activation, cross-origin isolation, SharedArrayBuffer, compatible hosting, and production licensing where applicable.`}]),i=class{optional;adapters=new Map;optionalStates=new Map;constructor(e=r){this.optional=e}register(e){if(this.adapters.has(e.capability.id))throw Error(`Execution runtime already registered: ${e.capability.id}`);if(e.capability.state!==`ready`)throw Error(`A registered execution adapter must report ready.`);this.adapters.set(e.capability.id,e),this.optionalStates.delete(e.capability.id)}unregister(e){this.adapters.delete(e)}setOptionalState(e,t,n){if(this.adapters.has(e))throw Error(`Cannot replace a ready execution runtime state: ${e}`);let r=this.optional.find(t=>t.id===e);if(!r)throw Error(`Unknown optional execution runtime: ${e}`);if(t===`ready`)throw Error(`A ready execution runtime requires a registered adapter.`);this.optionalStates.set(e,{...r,state:t,detail:n})}clearOptionalState(e){this.optionalStates.delete(e)}capabilities(){let e=[...this.adapters.values()].map(({capability:e})=>structuredClone(e));for(let t of this.optional)this.adapters.has(t.id)||e.push(structuredClone(this.optionalStates.get(t.id)??this.resolveOptionalState(t)));return e.sort((e,t)=>e.id.localeCompare(t.id))}async execute(e){if(e.signal.aborted)throw e.signal.reason??new DOMException(`Aborted`,`AbortError`);let t=this.adapters.get(e.runtime);if(!t){let t=this.capabilities().find(({id:t})=>t===e.runtime);throw t?.state===`installable`?Error(`${t.label} is an optional execution pack and has not been activated.`):t?.state===`activating`?Error(`${t.label} is still activating.`):t?.state===`failed`?Error(`${t.label} activation failed. ${t.detail}`):Error(`${t?.label??e.runtime} is unavailable on this device.`)}let n=await t.execute(e);if(n.runtime!==e.runtime)throw Error(`Execution adapter returned a mismatched runtime identity.`);return n}resolveOptionalState(e){if(typeof Worker>`u`||typeof WebAssembly>`u`)return{...e,state:`unavailable`,detail:`${e.detail} This browser has no Worker/WebAssembly runtime.`};if(e.id===`node-webcontainer`){if(typeof document>`u`)return{...e,state:`unavailable`,detail:`${e.detail} This environment has no browser document.`};if(globalThis.isSecureContext===!1)return{...e,state:`unavailable`,detail:`${e.detail} HTTPS or a loopback secure context is required.`};if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer>`u`)return{...e,state:`unavailable`,detail:`${e.detail} This page is not cross-origin isolated.`}}return{...e}}},a=64*1024,o=56e5,s=5e3,c=3e4,l=256*1024,u=256,d=512*1024,f=4*1024*1024,p=`airship-worker`,m=`314.0.2`,h=`/execution-packs/pyodide/`,g,_,v,y;function b(e,n){let r={definition:{name:`execute_javascript`,description:`Run bounded JavaScript in a disposable browser worker with no workspace, DOM, storage, or network binding; return or log the result.`,effect:`execute`,inputSchema:{type:`object`,properties:{code:{type:`string`,minLength:1,maxLength:a},timeoutMs:{type:`integer`,minimum:50,maximum:1e4}},required:[`code`],additionalProperties:!1}},async execute(e,t){let n=R(e),r=z(n.code,`code`),i=typeof n.timeoutMs==`number`?n.timeoutMs:s,a=await E(r,i,t.signal);return{content:JSON.stringify(a,null,2),metadata:{timeoutMs:i,logs:a.logs.length}}}};e.register(r),e.register({definition:{name:`install_execution_runtime`,description:`Cold-start an optional browser runtime; it reports ready only after a real probe.`,effect:`network`,inputSchema:{type:`object`,properties:{runtime:{type:`string`,enum:[`python-pyodide`,`node-webcontainer`]},timeoutMs:{type:`integer`,minimum:1e3,maximum:3e4}},required:[`runtime`],additionalProperties:!1}},async execute(e,t){let n=R(e),r=z(n.runtime,`runtime`),i=typeof n.timeoutMs==`number`?n.timeoutMs:c;if(r===`node-webcontainer`)return C(t.signal,i);if(r!==`python-pyodide`)throw Error(`${r} cannot be installed by this Airship release.`);await T(i,t.signal);let a=w().capabilities().find(({id:e})=>e===r);return{content:JSON.stringify(a,null,2),metadata:{runtime:r,state:a?.state??`unavailable`,version:m}}}}),e.register({definition:{name:`inspect_execution_runtimes`,description:`Report the coding runtimes this browser can execute now, activate explicitly, or cannot provide in this release.`,effect:`read`,inputSchema:{type:`object`,properties:{},additionalProperties:!1}},async execute(){return{content:JSON.stringify(w().capabilities(),null,2)}}}),e.register({definition:{name:`execute_code`,description:`Execute code in a ready client-side runtime. JavaScript Worker and compact WASI Preview 1 are built in; install Python explicitly first. Node/npm projects use the separately activated execute_node_project path.`,effect:`execute`,inputSchema:{type:`object`,properties:{runtime:{type:`string`,enum:[`javascript-worker`,`wasi-preview1`,`python-pyodide`]},code:{type:`string`,minLength:1,maxLength:a},wasmBase64:{type:`string`,minLength:12,maxLength:o},args:{type:`array`,maxItems:64,items:{type:`string`,maxLength:4096}},env:{type:`object`,maxProperties:64,additionalProperties:{type:`string`,maxLength:4096}},workspaceRoot:{type:`string`,minLength:1,maxLength:1024},sourcePath:{type:`string`,minLength:1,maxLength:1024},writeBack:{type:`boolean`},timeoutMs:{type:`integer`,minimum:50,maximum:1e4}},required:[`runtime`],additionalProperties:!1}},async execute(e,r){let i=R(e),a=z(i.runtime,`runtime`),o=typeof i.workspaceRoot==`string`?t(i.workspaceRoot):void 0,c=typeof i.sourcePath==`string`?t(i.sourcePath):void 0;if((o||c||i.writeBack===!0)&&a!==`python-pyodide`)throw Error(`Workspace-mounted execute_code is currently available only for python-pyodide.`);if((c||i.writeBack===!0)&&!o)throw Error(`Python sourcePath and writeBack require a workspaceRoot.`);if(c&&i.code!==void 0)throw Error(`Use either Python code or sourcePath, not both.`);let l={runtime:a,...typeof i.code==`string`?{code:i.code}:{},...typeof i.wasmBase64==`string`?{wasmBase64:i.wasmBase64}:{},args:B(i.args,`args`),env:V(i.env,`env`),...o?{workspaceRoot:o,workspace:n}:{},...c?{sourcePath:c}:{},writeBack:i.writeBack===!0,timeoutMs:typeof i.timeoutMs==`number`?i.timeoutMs:s,signal:r.signal},u=await w().execute(l),d=w().capabilities().find(({id:e})=>e===u.runtime);return{content:JSON.stringify(u,null,2),metadata:{runtime:u.runtime,exitCode:u.exitCode,isolation:d?.isolation??`unknown`,persistence:d?.persistence??`unknown`},isError:u.exitCode!==0}}}),e.register({definition:{name:`deactivate_execution_runtime`,description:`Terminate an optional runtime and release its in-tab processes and memory.`,effect:`execute`,inputSchema:{type:`object`,properties:{runtime:{type:`string`,enum:[`node-webcontainer`]}},required:[`runtime`],additionalProperties:!1}},async execute(e){let t=z(R(e).runtime,`runtime`);return y&&await(await y).deactivateNodeWebContainer(),w().unregister(t),w().clearOptionalState(t),{content:JSON.stringify(w().capabilities().find(({id:e})=>e===t),null,2)}}}),e.register({definition:{name:`execute_node_project`,description:`Run a direct Node/npm command in the in-browser WebContainer on a bounded workspace snapshot; writeBack adopts revision-checked text changes.`,effect:`network`,inputSchema:{type:`object`,properties:{workspaceRoot:{type:`string`,minLength:1,maxLength:1024},command:{type:`string`,minLength:1,maxLength:64,pattern:`^[A-Za-z0-9][A-Za-z0-9._-]*$`},args:{type:`array`,maxItems:64,items:{type:`string`,maxLength:4096}},env:{type:`object`,maxProperties:64,additionalProperties:{type:`string`,maxLength:4096}},timeoutMs:{type:`integer`,minimum:1e3,maximum:12e4},writeBack:{type:`boolean`}},required:[`workspaceRoot`,`command`],additionalProperties:!1}},async execute(e,r){if(!n)throw Error(`Node project execution has no workspace binding.`);let i=R(e),a={runtime:`node-webcontainer`,workspace:n,workspaceRoot:t(z(i.workspaceRoot,`workspaceRoot`)),command:z(i.command,`command`),args:B(i.args,`args`),env:V(i.env,`env`),timeoutMs:typeof i.timeoutMs==`number`?i.timeoutMs:3e4,writeBack:i.writeBack===!0,signal:r.signal},o=await w().execute(a);return{content:JSON.stringify(o,null,2),metadata:{runtime:o.runtime,exitCode:o.exitCode,provider:`StackBlitz WebContainers`},isError:o.exitCode!==0}}})}function x(e,t,n,r){let i=new Map;b({register(e){i.set(e.definition.name,e)}},r);let a=i.get(e);if(!a)throw Error(`Unknown execution tool: ${e}`);return a.execute(t,n)}function S(e){w().register(e)}async function C(t,n){let r=`node-webcontainer`,i=w().capabilities().find(({id:e})=>e===r);if(!i)throw Error(`Unknown optional runtime: ${r}`);if(i.state===`ready`)return{content:JSON.stringify(i,null,2)};if(i.state===`unavailable`)throw Error(i.detail);w().setOptionalState(r,`activating`,`Loading StackBlitz WebContainers.`);try{y??=e(()=>import(`./node-webcontainer-pack-DEzqz2JI.js`),__vite__mapDeps([0,1]));let i=await(await y).activateNodeWebContainer(t,n);return w().capabilities().some(({id:e,state:t})=>e===r&&t===`ready`)||w().register(i),{content:JSON.stringify(i.capability,null,2),metadata:{runtime:r,provider:`StackBlitz WebContainers`,browserCompute:!0,remoteRuntimeDelivery:!0}}}catch(e){let t=e instanceof Error?e.message:`Unknown WebContainer activation failure.`;throw w().capabilities().some(({id:e,state:t})=>e===r&&t===`ready`)||w().setOptionalState(r,`failed`,t),e}}function w(){return _||(_=new i,I()&&(_.register({capability:{id:`javascript-worker`,label:`JavaScript · disposable Worker`,languages:[`javascript`],state:`ready`,isolation:`disposable-worker`,persistence:`ephemeral`,detail:`Bounded evaluation with no DOM, storage, workspace, or network binding.`},async execute(e){if(!e.code)throw Error(`JavaScript execution requires code.`);let t=await E(e.code,e.timeoutMs,e.signal);return{runtime:`javascript-worker`,exitCode:0,stdout:t.logs.join(`
`),stderr:``,value:t.value}}}),typeof WebAssembly<`u`&&_.register({capability:{id:`wasi-preview1`,label:`WebAssembly · compact WASI Preview 1`,languages:[`compiled-wasm`],state:`ready`,isolation:`disposable-worker`,persistence:`ephemeral`,detail:`Runs a base64 command module with args, env, clock, random, stdout, and stderr; no sockets or mounted filesystem.`},async execute(e){if(!e.wasmBase64)throw Error(`WASI execution requires wasmBase64.`);return D(e.wasmBase64,e.args??[],e.env??{},e.timeoutMs,e.signal)}})),_)}async function T(e=c,t=new AbortController().signal){let n=w();if(!n.capabilities().some(({id:e,state:t})=>e===`python-pyodide`&&t===`ready`)){if(!I()||typeof WebAssembly>`u`)throw Error(`Pyodide requires browser Workers and WebAssembly.`);n.setOptionalState(`python-pyodide`,`activating`,`Loading the pinned Pyodide ${m} same-origin pack and running its interpreter probe.`),v??=(async()=>{let r=await A(`import sys
print(f'{sys.version_info.major}.{sys.version_info.minor}')`,[],{},e,t);if(r.exitCode!==0||!/^3\.\d+/u.test(r.stdout.trim()))throw Error(`Pyodide ${m} did not pass its interpreter probe.`);n.register({capability:{id:`python-pyodide`,label:`Python · Pyodide ${m}`,languages:[`python`],state:`ready`,isolation:`disposable-worker`,persistence:`ephemeral`,detail:`Fresh in-browser CPython interpreter per job with a bounded virtual workspace snapshot and optional revision-checked text writeback; standard library only, bounded output, hard termination, and no DOM, storage, sockets, package installation, or runtime network binding.`},async execute(e){if(!e.code&&!e.sourcePath)throw Error(`Python execution requires code or sourcePath.`);return O(e)}})})();try{await v}catch(e){throw v=void 0,n.setOptionalState(`python-pyodide`,`failed`,e instanceof Error?e.message:`Pyodide ${m} activation failed.`),e}}}async function E(e,t,n){if(typeof Worker>`u`||typeof URL.createObjectURL!=`function`)throw Error(`Disposable browser workers are unavailable in this environment.`);let r=N(e),i=URL.createObjectURL(new Blob([r],{type:`text/javascript`})),a;try{a=new Worker(M(i),{name:`airship-disposable-executor`})}catch(e){throw URL.revokeObjectURL(i),e}return new Promise((e,r)=>{let o=!1,s=(t,s)=>{o||(o=!0,clearTimeout(c),n.removeEventListener(`abort`,l),a.terminate(),URL.revokeObjectURL(i),t?r(t):e(s))},c=setTimeout(()=>s(Error(`JavaScript execution exceeded ${t} ms.`)),t),l=()=>s(n.reason??new DOMException(`Aborted`,`AbortError`));n.addEventListener(`abort`,l,{once:!0}),a.onerror=e=>s(Error(e.message||`Disposable JavaScript worker failed.`)),a.onmessage=e=>{let t=e.data;if(!t||typeof t!=`object`||Array.isArray(t)){s(Error(`Disposable JavaScript worker returned malformed output.`));return}let n=t;if(n.ok!==!0){s(Error(typeof n.error==`string`?n.error:`Disposable JavaScript execution failed.`));return}s(void 0,{value:L(n.value),logs:Array.isArray(n.logs)?n.logs.filter(e=>typeof e==`string`).slice(0,200):[]})},n.aborted&&l()})}async function D(e,t,n,r,i){if(!I()||typeof WebAssembly>`u`)throw Error(`Disposable WASI workers are unavailable in this environment.`);if(!/^[A-Za-z0-9+/]*={0,2}$/u.test(e)||e.length>o)throw Error(`wasmBase64 is malformed or exceeds the 4 MiB artifact limit.`);let a=URL.createObjectURL(new Blob([P()],{type:`text/javascript`})),s;try{s=new Worker(M(a),{name:`airship-wasi-preview1`})}catch(e){throw URL.revokeObjectURL(a),e}return new Promise((o,c)=>{let l=!1,u=(e,t)=>{l||(l=!0,clearTimeout(d),i.removeEventListener(`abort`,f),s.terminate(),URL.revokeObjectURL(a),e?c(e):o(t))},d=setTimeout(()=>u(Error(`WASI execution exceeded ${r} ms.`)),r),f=()=>u(i.reason??new DOMException(`Aborted`,`AbortError`));i.addEventListener(`abort`,f,{once:!0}),s.onerror=e=>u(Error(e.message||`Disposable WASI worker failed.`)),s.onmessage=e=>{if(!e.data||typeof e.data!=`object`||Array.isArray(e.data)){u(Error(`Disposable WASI worker returned malformed output.`));return}let t=e.data;if(t.ok!==!0){u(Error(typeof t.error==`string`?t.error:`Disposable WASI execution failed.`));return}u(void 0,{runtime:`wasi-preview1`,exitCode:typeof t.exitCode==`number`?t.exitCode:1,stdout:typeof t.stdout==`string`?t.stdout:``,stderr:typeof t.stderr==`string`?t.stderr:``})},i.aborted?f():s.postMessage({wasmBase64:e,args:[...t],env:{...n}})})}async function O(e){let t=e.workspace&&e.workspaceRoot?await k(e.workspace,e.workspaceRoot,e.sourcePath):void 0,n=await A(e.code??``,e.args??[],e.env??{},e.timeoutMs,e.signal,t,e.sourcePath);if(!t||!e.workspace)return n;let r=new Map(t.files.map(e=>[e.path,e])),i=new Map((n.workspaceFiles??[]).map(e=>[e.path,e])),a=[...i.values()].filter(e=>r.get(e.path)?.content!==e.content).sort((e,t)=>e.path.localeCompare(t.path)),o=t.files.filter(e=>!i.has(e.path)).sort((e,t)=>e.path.localeCompare(t.path)),s=[...a.map(({path:e})=>e),...o.map(({path:e})=>e)].sort(),c=[],l=[];if(e.writeBack&&n.exitCode===0){for(let t of a){let n=r.get(t.path)?.revision,i=await e.workspace.read(t.path);if(n?i?.revision!==n:i!==void 0)throw Error(`Python writeback conflicted at ${t.path}.`)}for(let t of o){let n=await e.workspace.read(t.path);if(!n||n.revision!==t.revision)throw Error(`Python deletion conflicted at ${t.path}.`)}for(let t of a){let n=r.get(t.path)?.revision??null;await e.workspace.write(t.path,t.content,{expectedRevision:n}),c.push(t.path)}for(let t of o)await e.workspace.remove(t.path,{expectedRevision:t.revision}),l.push(t.path)}let{workspaceFiles:u,...d}=n;return{...d,workspace:{root:t.root,mountedFiles:t.files.length,changedPaths:s,writtenPaths:c,deletedPaths:l,writeBack:e.writeBack===!0}}}async function k(e,r,i){let a=t(r);if(i&&i!==a&&!i.startsWith(`${a}/`))throw Error(`Python sourcePath must stay inside workspaceRoot.`);let o=(await e.list(a)).filter(({path:e})=>!n(e));if(o.length>u)throw Error(`Python workspace mount exceeds ${u} files.`);let s=[],c=0;for(let t of o){if(t.size>d)throw Error(`Python workspace file exceeds 512 KiB: ${t.path}`);let n=await e.read(t.path);if(!n)throw Error(`Python workspace file disappeared during snapshot: ${t.path}`);let r=new TextEncoder().encode(n.content).byteLength;if(c+=r,c>f)throw Error(`Python workspace mount exceeds 4 MiB.`);s.push({path:n.path,content:n.content,revision:n.revision})}if(i&&!s.some(({path:e})=>e===i))throw Error(`Python source file is not present in the workspace snapshot: ${i}`);return{root:a,files:s}}async function A(e,t,n,r,i,o,s){if(!I()||typeof WebAssembly>`u`)throw Error(`Disposable Pyodide workers are unavailable in this environment.`);if(!e.trim()&&!s||e.length>a)throw Error(`Python source must be between 1 and 64 KiB, or select sourcePath.`);if(t.length>64||t.some(e=>e.length>4096))throw Error(`Python arguments exceed the execution budget.`);let c=Object.entries(n);if(c.length>64||c.some(([e,t])=>!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(e)||t.length>4096))throw Error(`Python environment exceeds the execution budget.`);let d=new URL(h,globalThis.location.href).href,f=URL.createObjectURL(new Blob([F(d)],{type:`text/javascript`})),p;try{p=new Worker(M(f),{name:`airship-python-pyodide`,type:`module`})}catch(e){throw URL.revokeObjectURL(f),e}return new Promise((a,c)=>{let d=!1,m=(e,t)=>{d||(d=!0,clearTimeout(h),i.removeEventListener(`abort`,g),p.terminate(),URL.revokeObjectURL(f),e?c(e):a(t))},h=setTimeout(()=>m(Error(`Python execution exceeded ${r} ms.`)),r),g=()=>m(i.reason??new DOMException(`Aborted`,`AbortError`));i.addEventListener(`abort`,g,{once:!0}),p.onerror=e=>m(Error(e.message||`Disposable Pyodide worker failed.`)),p.onmessage=e=>{if(!e.data||typeof e.data!=`object`||Array.isArray(e.data)){m(Error(`Disposable Pyodide worker returned malformed output.`));return}let t=e.data;if(t.ok!==!0){m(Error(typeof t.error==`string`?t.error:`Disposable Pyodide initialization failed.`));return}let n=Array.isArray(t.workspaceFiles)?t.workspaceFiles.filter(j).slice(0,u):void 0;m(void 0,{runtime:`python-pyodide`,exitCode:typeof t.exitCode==`number`?t.exitCode:1,stdout:typeof t.stdout==`string`?t.stdout.slice(0,l):``,stderr:typeof t.stderr==`string`?t.stderr.slice(0,l):``,value:L(t.value),...n?{workspaceFiles:n}:{}})},i.aborted?g():p.postMessage({code:e,args:[...t],env:{...n},...o?{workspaceRoot:o.root,workspaceFiles:o.files.map(({path:e,content:t})=>({path:e,content:t}))}:{},...s?{sourcePath:s}:{}})})}function j(e){if(!e||typeof e!=`object`||Array.isArray(e))return!1;let t=e;return typeof t.path==`string`&&typeof t.content==`string`}function M(e){let t=globalThis.trustedTypes;return t?(g??=t.createPolicy(p,{createScriptURL(e){if(!e.startsWith(`blob:`))throw TypeError(`Airship workers require a freshly minted blob URL.`);return e}}),g.createScriptURL(e)):e}function N(e){return`"use strict";
const __logs = [];
const __render = value => {
  try { return typeof value === "string" ? value : JSON.stringify(value); }
  catch { return String(value); }
};
console.log = (...values) => { if (__logs.length < 200) __logs.push(values.map(__render).join(" ").slice(0, 4096)); };
console.info = console.log;
console.warn = console.log;
console.error = console.log;
for (const name of ["fetch", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
}
Promise.resolve().then(async () => {
  const value = await (async () => {
${e}
  })();
  postMessage({ ok: true, value: value === undefined ? null : value, logs: __logs });
}).catch(error => postMessage({ ok: false, error: String(error && error.stack || error), logs: __logs }));`}function P(){return`"use strict";
const LIMIT = 262144;
const encode = new TextEncoder();
const decode = new TextDecoder();
self.onmessage = async ({ data }) => {
  let stdout = "", stderr = "", memory, instance, exitCode = 0;
  const append = (fd, bytes) => {
    const text = decode.decode(bytes);
    if (fd === 1) stdout = (stdout + text).slice(0, LIMIT);
    if (fd === 2) stderr = (stderr + text).slice(0, LIMIT);
  };
  const view = () => {
    if (!memory) throw new Error("WASI command did not export memory.");
    return new DataView(memory.buffer);
  };
  const writeStrings = (values, pointers, buffer) => {
    const dataView = view();
    let cursor = buffer;
    values.forEach((value, index) => {
      const bytes = encode.encode(value + "\\0");
      dataView.setUint32(pointers + index * 4, cursor, true);
      new Uint8Array(memory.buffer, cursor, bytes.length).set(bytes);
      cursor += bytes.length;
    });
  };
  const argv = ["airship-wasi", ...(Array.isArray(data.args) ? data.args : [])];
  const environ = Object.entries(data.env || {}).map(([key, value]) => key + "=" + value);
  const wasi = {
    args_sizes_get(argc, size) { const v=view(); v.setUint32(argc, argv.length, true); v.setUint32(size, argv.reduce((n,s)=>n+encode.encode(s).length+1,0), true); return 0; },
    args_get(pointers, buffer) { writeStrings(argv, pointers, buffer); return 0; },
    environ_sizes_get(count, size) { const v=view(); v.setUint32(count, environ.length, true); v.setUint32(size, environ.reduce((n,s)=>n+encode.encode(s).length+1,0), true); return 0; },
    environ_get(pointers, buffer) { writeStrings(environ, pointers, buffer); return 0; },
    fd_write(fd, iovs, length, written) {
      const v=view(); let total=0;
      for (let i=0;i<length;i+=1) { const pointer=v.getUint32(iovs+i*8,true), size=v.getUint32(iovs+i*8+4,true); append(fd,new Uint8Array(memory.buffer,pointer,size)); total+=size; }
      v.setUint32(written,total,true); return fd === 1 || fd === 2 ? 0 : 8;
    },
    fd_close() { return 0; }, fd_fdstat_get() { return 0; }, fd_seek() { return 70; },
    clock_time_get(_clock, _precision, time) { const now=BigInt(Date.now())*1000000n; view().setBigUint64(time,now,true); return 0; },
    random_get(pointer, length) { crypto.getRandomValues(new Uint8Array(memory.buffer,pointer,length)); return 0; },
    proc_exit(code) { const error=new Error("WASI_EXIT"); error.exitCode=code; throw error; },
  };
  const imports = new Proxy(wasi, { get(target, name) { return target[name] || (() => 52); } });
  try {
    const binary = Uint8Array.from(atob(data.wasmBase64), value => value.charCodeAt(0));
    if (binary.byteLength > 4194304 || !WebAssembly.validate(binary)) throw new Error("Invalid or oversized WebAssembly artifact.");
    const result = await WebAssembly.instantiate(binary, { wasi_snapshot_preview1: imports, wasi_unstable: imports });
    instance = result.instance; memory = instance.exports.memory;
    if (memory && memory.buffer.byteLength > 67108864) throw new Error("WASI initial memory exceeds 64 MiB.");
    const start = instance.exports._start || instance.exports._initialize;
    if (typeof start !== "function") throw new Error("WASI command must export _start or _initialize.");
    try { start(); } catch (error) { if (error && error.message === "WASI_EXIT") exitCode=error.exitCode; else throw error; }
    postMessage({ ok:true, exitCode, stdout, stderr });
  } catch (error) { postMessage({ ok:false, error:String(error && error.stack || error) }); }
};`}function F(e){return`"use strict";
const PYODIDE_MODULE = ${JSON.stringify(new URL(`pyodide.mjs`,e).href)};
const PYODIDE_BASE = ${JSON.stringify(e)};
const LIMIT = ${l};
const boundedAppend = (current, value) => {
  if (current.length >= LIMIT) return current;
  const addition = String(value) + "\\n";
  return (current + addition).slice(0, LIMIT);
};
const jsonValue = value => {
  let converted = value;
  try {
    if (value && typeof value.toJs === "function") converted = value.toJs();
    const encoded = JSON.stringify(converted === undefined ? null : converted);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch { return String(converted); }
  finally { try { if (value && typeof value.destroy === "function") value.destroy(); } catch {} }
};
const mountWorkspace = (pyodide, data) => {
  if (!data.workspaceRoot) return;
  pyodide.FS.mkdirTree(data.workspaceRoot);
  for (const file of Array.isArray(data.workspaceFiles) ? data.workspaceFiles : []) {
    const slash = file.path.lastIndexOf("/");
    pyodide.FS.mkdirTree(file.path.slice(0, slash) || "/workspace");
    pyodide.FS.writeFile(file.path, file.content, { encoding:"utf8" });
  }
  pyodide.FS.chdir(data.workspaceRoot);
};
const collectWorkspace = (pyodide, root) => {
  if (!root) return undefined;
  const files = []; let total = 0;
  const visit = directory => {
    for (const name of pyodide.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = directory === "/" ? "/" + name : directory + "/" + name;
      const stat = pyodide.FS.stat(path);
      if (pyodide.FS.isDir(stat.mode)) { visit(path); continue; }
      if (!pyodide.FS.isFile(stat.mode)) continue;
      const bytes = pyodide.FS.readFile(path);
      if (bytes.byteLength > ${d}) throw new Error("Python generated a file over 512 KiB: " + path);
      let content;
      try { content = new TextDecoder("utf-8", { fatal:true }).decode(bytes); } catch { continue; }
      total += bytes.byteLength;
      if (files.length >= ${u} || total > ${f}) throw new Error("Python workspace output exceeded its mount budget.");
      files.push({ path, content });
    }
  };
  visit(root);
  return files;
};
self.onmessage = async ({ data }) => {
  let pyodide;
  try {
    const module = await import(PYODIDE_MODULE);
    pyodide = await module.loadPyodide({ indexURL: PYODIDE_BASE, fullStdLib: false });
  } catch (error) {
    postMessage({ ok:false, error:"Pyodide initialization failed: " + String(error && error.message || error) });
    return;
  }
  let stdout = "", stderr = "";
  pyodide.setStdout({ batched: value => { stdout = boundedAppend(stdout, value); } });
  pyodide.setStderr({ batched: value => { stderr = boundedAppend(stderr, value); } });
  try { pyodide.setStdin({ stdin: () => null }); } catch {}
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  mountWorkspace(pyodide, data);
  let exitCode = 0, value = null;
  try {
    const argv = ["airship.py", ...(Array.isArray(data.args) ? data.args : [])];
    const environment = data.env && typeof data.env === "object" ? data.env : {};
    await pyodide.runPythonAsync(
      "import os, sys\\n" +
      "sys.argv = " + JSON.stringify(argv) + "\\n" +
      "os.environ.update(" + JSON.stringify(environment) + ")",
    );
    const executionSource = data.sourcePath
      ? pyodide.FS.readFile(data.sourcePath, { encoding:"utf8" })
      : String(data.code || "");
    value = jsonValue(await pyodide.runPythonAsync(executionSource, { filename:data.sourcePath || "<airship>" }));
  } catch (error) {
    exitCode = 1;
    stderr = boundedAppend(stderr, String(error && error.message || error));
  }
  try {
    postMessage({ ok:true, exitCode, stdout, stderr, value, workspaceFiles:collectWorkspace(pyodide, data.workspaceRoot) });
  } catch (error) {
    postMessage({ ok:false, error:"Python workspace collection failed: " + String(error && error.message || error) });
  }
};`}function I(){return typeof Worker<`u`&&typeof URL.createObjectURL==`function`}function L(e){try{let t=JSON.stringify(e===void 0?null:e);return t===void 0?null:JSON.parse(t)}catch{return String(e)}}function R(e){if(!e||typeof e!=`object`||Array.isArray(e))throw Error(`Tool arguments must be an object.`);return e}function z(e,t){if(typeof e!=`string`||!e.trim())throw Error(`${t} must be a non-empty string.`);return e}function B(e,t){if(e===void 0)return[];if(!Array.isArray(e)||e.some(e=>typeof e!=`string`))throw Error(`${t} must contain only strings.`);return e}function V(e,t){if(e===void 0)return{};if(!e||typeof e!=`object`||Array.isArray(e))throw Error(`${t} must be an object.`);if(Object.values(e).some(e=>typeof e!=`string`))throw Error(`${t} values must be strings.`);return e}export{x as executeExecutionTool,w as getClientExecutionRuntime,S as installExecutionAdapter,T as installPyodideExecutionRuntime,A as runDisposablePyodide,D as runDisposableWasi,E as runDisposableWorker};