import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Four fixed units, a single in-flight read/cache and 4 KiB command output.
// Never return journal contents, environment, command lines or authentication.
export function createServiceDiagnostics(run = exec, mode = 'desktop') {
  const hostUnit = mode === 'terminal' ? 'codex-cloud-terminal.service' : 'codex-cloud-actions.service';
  const units = { 'codex-cloud-panel.service': 'panel', 'codex-cloud-manager.service': 'manager', [hostUnit]: mode === 'terminal' ? 'terminal' : 'actions', 'codex-cloud-files.service': 'files' };
  let cache;
  return function read() {
    if (cache && Date.now() - cache.at < 3000) return cache.promise;
    const promise = (async () => {
      try {
        const { stdout } = await run('systemctl', ['--user', 'show', ...Object.keys(units), '--property=Id,LoadState,ActiveState,Result,NRestarts'], { timeout: 1500, maxBuffer: 4096, encoding: 'utf8' });
        if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) throw Error();
        const services = {}, blocks = stdout.trim().split(/\n\s*\n/);
        if (blocks.length !== 4) throw Error();
        for (const block of blocks) {
          const row = Object.create(null);
          for (const line of block.split('\n')) {
            const at = line.indexOf('='), name = line.slice(0, at);
            if (at < 0 || !['Id', 'LoadState', 'ActiveState', 'Result', 'NRestarts'].includes(name) || Object.hasOwn(row, name)) throw Error();
            row[name] = line.slice(at + 1);
          }
          const key = Object.hasOwn(units, row.Id) ? units[row.Id] : null;
          if (!key || services[key] || !['active', 'inactive', 'activating', 'deactivating', 'failed', 'reloading'].includes(row.ActiveState)) throw Error();
          if (!['loaded', 'not-found', 'masked', 'error', 'bad-setting', 'merged', 'stub'].includes(row.LoadState)) throw Error();
          if (row.LoadState === 'not-found') {
            if (row.ActiveState !== 'inactive' || row.NRestarts && row.NRestarts !== '0') throw Error();
            services[key] = { state: 'missing', restarts: 0, limited: false }; continue;
          }
          if (!/^\d{1,9}$/.test(row.NRestarts)) throw Error();
          // systemd 237 retains Result=signal after exhausting its start budget.
          // With the fixed panel/files policy, failed plus three recoveries
          // also means automatic recovery has stopped.
          services[key] = { state: row.ActiveState, restarts: Number(row.NRestarts), limited: row.Result === 'start-limit-hit' || ['panel', 'files'].includes(key) && row.ActiveState === 'failed' && Number(row.NRestarts) >= 3 };
        }
        if (Object.keys(services).length !== 4) throw Error();
        return { available: true, ...services };
      } catch { return { available: false }; }
    })();
    cache = { at: Date.now(), promise }; return promise;
  };
}
