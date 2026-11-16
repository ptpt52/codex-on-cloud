import { centerClient, centerRequest } from '../panel/center-http.mjs';

export async function httpsHealth(origin, _serverName, ca) {
  return (await centerHealthStatus(origin, { ca })).ok;
}

const networkReason = error => ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'dns' :
  ['TimeoutError', 'AbortError'].includes(error.name) || ['ETIMEDOUT', 'ABORT_ERR'].includes(error.code) ? 'timeout' :
    /^(?:ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(error.code || '') ? 'tls' : 'network';

export async function centerHealthStatus(origin, { request = centerRequest, ca } = {}) {
  try {
    const response = await centerClient(origin, ca, request)(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, reason: 'http_status', status: response.status };
    let value; try { value = await response.json(); } catch { return { ok: false, reason: 'response_format' }; }
    return value?.ok === true ? { ok: true } : { ok: false, reason: 'center_not_ready' };
  } catch (error) { return { ok: false, reason: networkReason(error) }; }
}

export async function nodeEntryStatus(connection, { request = centerRequest, ca } = {}) {
  try {
    const response = await centerClient(connection.origin, ca, request)(connection.origin + connection.path + 'readyz', {
      headers: { 'x-codex-node': connection.nodeId }, redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { ok: false, reason: 'http_status', status: response.status };
    let value; try { value = await response.json(); } catch { return { ok: false, reason: 'response_format' }; }
    if (value?.nodeId !== connection.nodeId) return { ok: false, reason: 'node_identity' };
    return value.ok === true && value.host === true && value.files === true ? { ok: true } : { ok: false, reason: 'node_not_ready' };
  } catch (error) { return { ok: false, reason: networkReason(error) }; }
}

export async function nodeEntryReady(connection, options) { return (await nodeEntryStatus(connection, options)).ok; }
