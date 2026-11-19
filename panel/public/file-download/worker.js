// Fixed two-slot, page-owned streaming relay. Bytes never enter CacheStorage,
// IndexedDB or a server; a browser download consumes them with backpressure.
const LIMITS = Object.freeze({ jobs: 2, bytes: 1024 * 1024 * 1024, block: 256 * 1024, prepareMs: 10000, idleMs: 15000, ageMs: 30 * 60 * 1000 });
const jobs = new Map(), scope = new URL(self.registration.scope);
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const value = event.data, port = event.ports[0], source = event.source;
  if (!port || event.ports.length !== 1) return;
  const invalid = () => { port.postMessage({ type: 'error' }); port.close(); };
  let from, encodedName; try { from = new URL(source?.url); } catch { invalid(); return; }
  if (from.origin !== scope.origin || from.pathname !== scope.pathname + 'bridge.html' || !source.id || value?.type !== 'download-open' || !/^[a-f0-9]{32}$/.test(value.token || '') || typeof value.name !== 'string' || !value.name || value.name.length > 255 || new TextEncoder().encode(value.name).length > 255 || /[\x00-\x1f\x7f/]/.test(value.name) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > LIMITS.bytes || jobs.size >= LIMITS.jobs || jobs.has(value.token) || [...jobs.values()].some(job => job.owner === source.id)) { invalid(); return; }
  try { encodedName = encodeURIComponent(value.name).replace(/[!'()*]/g, part => '%' + part.charCodeAt(0).toString(16)); } catch { invalid(); return; }
  const job = { owner: source.id, ownerURL: source.url, port, size: value.size, encodedName, loaded: 0, started: false, pull: null, controller: null };
  jobs.set(value.token, job);
  const arm = ms => { clearTimeout(job.timer); job.timer = setTimeout(() => stop(false, 'timeout'), ms); };
  function stop(ok, reason = 'protocol') {
    if (!jobs.delete(value.token)) return;
    clearTimeout(job.timer); clearTimeout(job.age);
    if (!ok) { try { job.controller?.error(Error('Download interrupted')); } catch {} }
    job.pull?.(); job.pull = null;
    try { port.postMessage({ type: ok ? 'done' : 'error', reason, loaded: job.loaded }); } catch {}
    port.close();
  }
  job.stop = stop; job.arm = arm;
  job.age = setTimeout(() => stop(false), LIMITS.ageMs); arm(LIMITS.prepareMs);
  port.onmessageerror = () => stop(false);
  port.onmessage = ({ data }) => {
    if (!jobs.has(value.token)) return;
    if (data?.type === 'end' && job.started && job.loaded === job.size) { job.controller.close(); stop(true); return; }
    if (data?.type !== 'chunk' || !job.started || !job.pull || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength !== Math.min(LIMITS.block, job.size - job.loaded) || data.bytes.byteLength <= 0) { stop(false); return; }
    const release = job.pull; job.pull = null;
    job.loaded += data.bytes.byteLength; job.controller.enqueue(new Uint8Array(data.bytes)); release();
    arm(LIMITS.idleMs); port.postMessage({ type: 'accepted' });
  };
  port.postMessage({ type: 'ready' });
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'save/')) return;
  const token = url.pathname.slice((scope.pathname + 'save/').length), job = jobs.get(token);
  const owned = job && (event.clientId === job.owner || !event.clientId && event.request.mode === 'navigate' && event.request.referrer === job.ownerURL);
  if (event.request.method !== 'GET' || url.search || !job || job.started || !owned) {
    event.respondWith(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })); return;
  }
  job.started = true; job.arm(LIMITS.idleMs);
  const stream = new ReadableStream({
    start(controller) { job.controller = controller; },
    pull() { return new Promise(resolve => { job.pull = resolve; job.port.postMessage({ type: 'pull' }); }); },
    cancel() { job.stop(false, 'consumer-cancel'); },
  }, { highWaterMark: 0 });
  event.respondWith(new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(job.size), 'content-disposition': "attachment; filename=download.bin; filename*=UTF-8''" + job.encodedName, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }));
  job.port.postMessage({ type: 'started' });
});
