export const FORWARD_CLIENTS = Object.freeze({
  'windows-amd64': Object.freeze({ name: 'codex-cloud-forward-windows-amd64.exe', label: 'Windows x64', os: 'windows', format: 'exe' }),
  'windows-arm64': Object.freeze({ name: 'codex-cloud-forward-windows-arm64.exe', label: 'Windows ARM64', os: 'windows', format: 'exe' }),
  'darwin-arm64': Object.freeze({ name: 'codex-cloud-forward-macos-arm64.zip', label: 'Mac Apple Silicon（M 系列）', os: 'darwin', format: 'zip' }),
  'darwin-amd64': Object.freeze({ name: 'codex-cloud-forward-macos-amd64.zip', label: 'Mac Intel', os: 'darwin', format: 'zip' }),
});

export function forwardOS(device) {
  const platform = String(device?.userAgentData?.platform || device?.platform || ''), ua = String(device?.userAgent || '');
  if (/iPhone|iPad|iPod|Android/i.test(platform + ' ' + ua) || /Mac/i.test(platform) && device?.maxTouchPoints > 1) return null;
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'darwin';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  return null;
}

// Query only when the download dialog is opened. No fingerprint is persisted or
// sent to the server; missing/denied hints leave architecture selection manual.
export async function detectForwardClient(device) {
  const os = forwardOS(device), fallback = { os, arch: null };
  if (!os || !device?.userAgentData?.getHighEntropyValues) return fallback;
  let timer;
  try {
    const values = await Promise.race([
      device.userAgentData.getHighEntropyValues(['architecture', 'bitness']),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); }),
    ]);
    const arch = values?.bitness === '64' ? values.architecture === 'arm' ? 'arm64' : values.architecture === 'x86' ? 'amd64' : null : null;
    return { os, arch: arch ? os + '-' + arch : null };
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}
