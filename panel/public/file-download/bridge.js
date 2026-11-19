// Only this inert frame is controlled by the download worker. Updating it
// never takes over the workbench's shell worker or changes an input session.
let active, keepAlive;
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const value = event.data;
  if (value?.type === 'download-release' && active?.token === value.token) { clearInterval(keepAlive); keepAlive = undefined; active = undefined; return; }
  if (value?.type === 'download-save' && active?.token === value.token) {
    // Native <a download> requests can bypass a service worker. A navigation
    // to the attachment response leaves this inert frame in place instead.
    location.href = new URL('save/' + active.token, location.href).href; return;
  }
  if (active || value?.type !== 'download-open' || !/^[a-f0-9]{32}$/.test(value.token || '') || event.ports.length !== 1) return;
  active = { token: value.token, name: value.name }; const port = event.ports[0];
  try {
    const script = new URL('worker.js', location.href), node = new URL(location.href).searchParams.get('node');
    if (node) script.searchParams.set('node', node);
    const registration = await navigator.serviceWorker.register(script, { scope: new URL('./', location.href).href });
    const worker = registration.active || await new Promise((resolve, reject) => {
      const pending = registration.installing || registration.waiting;
      if (!pending) return reject(Error('Download worker unavailable'));
      const timer = setTimeout(() => reject(Error('Download worker unavailable')), 7000);
      const changed = () => { if (pending.state === 'activated') { clearTimeout(timer); pending.removeEventListener('statechange', changed); resolve(pending); } else if (pending.state === 'redundant') { clearTimeout(timer); reject(Error('Download worker unavailable')); } };
      pending.addEventListener('statechange', changed); changed();
    });
    worker.postMessage(value, [port]);
    // Short events keep a live download worker available without holding one
    // extendable event past a browser's long-event deadline. No file, lease or
    // idle deadline is renewed by this signal.
    keepAlive = setInterval(() => worker.postMessage({ type: 'download-alive' }), 5000);
  } catch { port.postMessage({ type: 'error' }); port.close(); }
});
