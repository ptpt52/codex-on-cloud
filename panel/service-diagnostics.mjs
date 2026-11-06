import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Three fixed units, a single in-flight read/cache and 4 KiB command output.
// Never return journal contents, environment, command lines or authentication.
export function createServiceDiagnostics(run = exec) {
  let cache;
  return function read() {
    if (cache && Date.now() - cache.at < 3000) return cache.promise;
    const promise = (async () => {
      try {
        const { stdout } = await run('systemctl', ['--user', 'show', 'codex-cloud-panel.service', 'codex-cloud-manager.service', 'codex-cloud-actions.service', '--property=Id,ActiveState,Result,NRestarts'], { timeout: 1500, maxBuffer: 4096, encoding: 'utf8' });
        if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) throw Error();
        const services = {}, blocks = stdout.trim().split(/\n\s*\n/);
        if (blocks.length !== 3) throw Error();
        for (const block of blocks) {
          const row = Object.fromEntries(block.split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
          const key = { 'codex-cloud-panel.service': 'panel', 'codex-cloud-manager.service': 'manager', 'codex-cloud-actions.service': 'actions' }[row.Id];
          if (!key || services[key] || !['active', 'inactive', 'activating', 'deactivating', 'failed', 'reloading'].includes(row.ActiveState)) throw Error();
          if (!/^\d{1,9}$/.test(row.NRestarts)) throw Error();
          // systemd 237 retains Result=signal after exhausting its start budget.
          // With our fixed panel policy, failed plus three scheduled recoveries
          // also means automatic recovery has stopped.
          services[key] = { state: row.ActiveState, restarts: Number(row.NRestarts), limited: row.Result === 'start-limit-hit' || key === 'panel' && row.ActiveState === 'failed' && Number(row.NRestarts) >= 3 };
        }
        if (Object.keys(services).length !== 3) throw Error();
        return { available: true, ...services };
      } catch { return { available: false }; }
    })();
    cache = { at: Date.now(), promise }; return promise;
  };
}
