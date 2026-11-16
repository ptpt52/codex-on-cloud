import { centerClient, centerRequest } from '../panel/center-http.mjs';
import { CREDENTIAL, enrollmentCredential, enrollmentOperation } from './protocol.mjs';

// Querying a receipt never repeats enrollment. Proofs and credentials stay in
// private state / authenticated request bodies, never in URLs or diagnostics.
export async function queryEnrollment(intent, { request = centerRequest } = {}) {
  if (!intent.operation || !['desktop', 'terminal'].includes(intent.mode)) return { state: 'unknown', reason: 'legacy_receipt' };
  enrollmentOperation(intent.operation);
  const { target, operation } = intent;
  const response = await centerClient(target.origin, intent.ca || undefined, request)(target.origin + '/api/join-result', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, slug: target.slug, nodeId: target.nodeId, mode: intent.mode, operation }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return { state: 'unknown', reason: response.status === 404 ? 'receipt_unavailable' : 'http_status', status: response.status };
  let result; try { result = await response.json(); } catch { throw Error('中心接入查询响应格式无效'); }
  if (result?.version !== 1 || result.state !== 'accepted' || result.operationId !== operation.id || result.slug !== target.slug || result.nodeId !== target.nodeId ||
    result.mode !== intent.mode || typeof result.credential !== 'string' || !CREDENTIAL.test(result.credential) || result.credential !== enrollmentCredential(operation, target.nodeId, intent.mode)) throw Error('中心接入查询身份或凭据无效');
  return { state: 'accepted', credential: result.credential };
}
