import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTerminalManager } from './terminals.mjs';
import { terminalEnvironment } from './deployment-mode.mjs';

const exec = promisify(execFile);
export function createTerminalControls(config) {
  const env = terminalEnvironment(config);
  const run = async (command, args) => (await exec(command, args, { env, timeout: 2000, maxBuffer: 16384, encoding: 'utf8' })).stdout.trim();
  const terminals = createTerminalManager(config, { run });
  let busy = false;
  const status = () => ({ available: true, terminalOnly: true, maintenance: false, inputBusy: busy, clipboardBusy: false, viewportBusy: false });
  const unsupported = () => { throw Object.assign(Error('纯终端部署未启用桌面操作'), { status: 501, outcome: 'rejected' }); };
  return {
    ready: Promise.resolve(), status,
    get: async () => ({ actual: null, saved: null, session: null, busy, canResize: false }),
    listTerminals: terminals.list,
    async manageTerminals(body) {
      if (busy) throw Object.assign(Error('终端操作正在进行，请稍后刷新'), { status: 409, outcome: 'rejected' });
      busy = true;
      try { return await terminals.manage({ ...body, view: 'terminal' }); } finally { busy = false; }
    },
    save: unsupported, apply: unsupported, applyResolution: unsupported, resizeViewport: unsupported,
    terminal: unsupported, input: unsupported, clipboard: unsupported,
  };
}
