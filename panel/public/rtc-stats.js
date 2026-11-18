import { vpnIP } from './rtc-address.js';
function endpoint(value) {
  if (!value) return null;
  const address = value?.address || value?.ip;
  return { address: typeof address === 'string' && address.length <= 253 && /^[a-zA-Z0-9:.%-]+$/.test(address) ? address : null,
    port: Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535 ? value.port : null,
    type: ['host', 'srflx', 'prflx', 'relay'].includes(value.candidateType) ? value.candidateType : 'unknown' };
}
export function selectedRoute(stats) {
  const rows = [...stats.values()];
  const selected = rows.find(row => row.type === 'transport' && row.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair = selected ? stats.get(selected) : rows.find(row => row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated);
  if (!pair || pair.state !== 'succeeded') return null;
  const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
  const from = endpoint(local), to = endpoint(remote);
  if (!from || !to) return null;
  const protocol = String(remote.protocol || local.protocol || '').toUpperCase();
  return { family: to.address?.includes(':') ? 'IPv6' : /^\d+\.\d+\.\d+\.\d+$/.test(to.address || '') ? 'IPv4' : 'unknown',
    protocol: ['UDP', 'TCP'].includes(protocol) ? protocol : 'unknown', local: from, remote: to,
    rttMs: Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0 && pair.currentRoundTripTime <= 600 ? Math.round(pair.currentRoundTripTime * 1000) : null };
}

export function rtcRouteKind(route) {
  const types = [route?.local?.type, route?.remote?.type];
  if (types.includes('relay')) return 'relay';
  return types.every(type => ['host', 'srflx', 'prflx'].includes(type)) ? 'direct' : 'unknown';
}

export function rtcRouteLabel(route) {
  const kind = rtcRouteKind(route);
  if (kind !== 'direct') return { relay: 'WebRTC 加密中继（TURN）', unknown: 'WebRTC 加密通道（路径待确认）' }[kind];
  const label = rtcDirectLabel(rtcDirectKind(route));
  return `WebRTC 加密直连${label ? `（${label}）` : ''}`;
}

export function rtcDirectKind(route) {
  if (rtcRouteKind(route) !== 'direct') return 'unknown';
  const values = [route.local, route.remote];
  const family = route.family || (values.some(value => value.address?.includes(':')) ? 'IPv6' : values.some(value => /^\d+\.\d+\.\d+\.\d+$/.test(value.address || '')) ? 'IPv4' : 'unknown');
  if (values.some(value => vpnIP(value.address))) return 'vpn';
  if (family === 'IPv6') return 'ipv6';
  if (family !== 'IPv4') return 'unknown';
  const private4 = value => /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value.address || '');
  if (values.every(private4)) return 'lan';
  if (values.some(value => ['srflx', 'prflx'].includes(value.type) && value.address && !private4(value))) return 'nat';
  return values.every(value => /^\d+\.\d+\.\d+\.\d+$/.test(value.address || '')) ? 'public-ipv4' : 'unknown';
}

export function rtcDirectLabel(kind) { return { vpn: 'VPN', lan: '局域网', ipv6: 'IPv6', nat: 'NAT 打洞', 'public-ipv4': '公网 IPv4' }[kind] || ''; }

export function gatherCandidates(peer, signal) {
  if (signal.aborted) return Promise.reject(new Error('直连协商已取消'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false, fastExpired = false;
    const urls = (peer.getConfiguration?.().iceServers || []).flatMap(server => Array.isArray(server.urls) ? server.urls : [server.urls]);
    const wantsRelay = urls.some(url => /^turns?:/.test(url));
    const wantsReflexive = urls.some(url => /^stun:/.test(url));
    const usable = () => {
      const sdp = peer.localDescription?.sdp || '';
      const types = wantsRelay ? 'relay' : wantsReflexive ? '(?:srflx|prflx|relay)' : '(?:host|srflx|prflx|relay)';
      return new RegExp('^a=candidate:.*\\styp ' + types + '(?:\\s|$)', 'm').test(sdp);
    };
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(fastTimer); clearTimeout(maxTimer);
      peer.removeEventListener('icegatheringstatechange', changed);
      peer.removeEventListener('icecandidate', changed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete' || fastExpired && usable()) finish(); };
    const aborted = () => finish(new Error('直连协商已取消'));
    // Keep completed/local-only gathering fast, but allow slow STUN/TURN a
    // bounded second chance before taking the snapshot used by non-trickle SDP.
    const fastTimer = setTimeout(() => { fastExpired = true; changed(); }, 1500);
    const maxTimer = setTimeout(() => finish(), 3000);
    peer.addEventListener('icegatheringstatechange', changed);
    peer.addEventListener('icecandidate', changed);
    signal.addEventListener('abort', aborted, { once: true });
    changed();
  });
}
