import { join } from 'node:path';

function quote(value) {
  if (/[\r\n\0]/.test(value)) throw Error('服务路径不能包含换行或 NUL');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
}
export function serviceUnits(root, path, node = process.execPath, mode = 'desktop') {
  const desktop = 'codex-cloud-desktop.service', worker = 'codex-cloud-actions.service', manager = 'codex-cloud-manager.service', panel = 'codex-cloud-panel.service';
  function unit(description, script, extra = '', recovery = '') {
    const limit = recovery === 'panel' ? 'StartLimitIntervalSec=60\nStartLimitBurst=3\n' : recovery === 'tunnel' ? 'StartLimitIntervalSec=0\n' : '';
    return `# Managed by codex-on-cloud\n[Unit]\nDescription=${description}\n${extra}${limit}\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll('%', '%%').replaceAll(' ', '\\x20')}\nEnvironment=${quote('PATH=' + path)}\nExecStart=${[node, join(root, script)].map(quote).join(' ')}\nRestart=${recovery ? 'on-failure' : 'no'}\n${recovery ? `RestartSec=${recovery === 'panel' ? 5 : 10}\n` : ''}KillMode=control-group\nTimeoutStopSec=15\nUMask=0077\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=codex-cloud\n\n[Install]\nWantedBy=default.target\n`;
  }
  if (mode === 'terminal') return new Map([
    ['codex-cloud-terminal.service', unit('Codex Cloud persistent terminal host', 'native/terminal-host.mjs')],
    [manager, unit('Codex Cloud terminal manager', 'native/manager.mjs', 'After=codex-cloud-terminal.service\n')],
    [panel, unit('Codex Cloud browser gateway', 'panel/main.mjs', `After=codex-cloud-terminal.service ${manager}\n`, 'panel')],
    ['codex-cloud-tunnel.service', unit('Codex Cloud Cloudflare Tunnel', 'native/tunnel.mjs', `After=${panel}\n`, 'tunnel')],
  ]);
  return new Map([
    [desktop, unit('Codex Cloud independent virtual desktop', 'native/desktop.mjs')],
    [worker, unit('Codex Cloud desktop windows and selection owner', 'native/desktop-worker.mjs', `After=${desktop}\nRequisite=${desktop}\nPartOf=${desktop}\n`)],
    [manager, unit('Codex Cloud fixed desktop settings manager', 'native/manager.mjs', `After=${desktop} ${worker}\nWants=${worker}\n`)],
    [panel, unit('Codex Cloud browser gateway', 'panel/main.mjs', `After=${desktop} ${manager}\n`, 'panel')],
    ['codex-cloud-tunnel.service', unit('Codex Cloud Cloudflare Tunnel', 'native/tunnel.mjs', `After=${panel}\n`, 'tunnel')],
  ]);
}
