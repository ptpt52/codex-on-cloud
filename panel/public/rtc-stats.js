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

export function gatherCandidates(peer, signal) {
  if (signal.aborted) return Promise.reject(new Error('直连协商已取消'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const aborted = () => finish(new Error('直连协商已取消'));
    // An unreachable STUN service must not delay usable local host candidates.
    const timer = setTimeout(() => finish(), 1500);
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', aborted, { once: true });
    changed();
  });
}
