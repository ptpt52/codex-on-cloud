const schemes = /^(?:stun|turn|turns):/;
export function rtcIceServers(settings = {}) {
  const result = [], seen = new Set();
  const add = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const urls = (Array.isArray(value.urls) ? value.urls : [value.urls]).filter(url => typeof url === 'string' && url.length <= 256 && schemes.test(url));
    if (!urls.length || urls.length > 4) return;
    const turn = urls.some(url => /^turns?:/.test(url));
    if (turn && (typeof value.username !== 'string' || !value.username || value.username.length > 128 || typeof value.credential !== 'string' || !value.credential || value.credential.length > 128)) return;
    const key = urls.join('\n'); if (seen.has(key)) return; seen.add(key); result.push(turn ? { urls, username: value.username, credential: value.credential } : { urls });
  };
  if (Array.isArray(settings.rtcIceServers)) for (const value of settings.rtcIceServers.slice(0, 4)) add(value);
  if (typeof settings.rtcStunUrl === 'string' && settings.rtcStunUrl.startsWith('stun:') && settings.rtcStunUrl.length <= 256) add({ urls: settings.rtcStunUrl });
  return result;
}
