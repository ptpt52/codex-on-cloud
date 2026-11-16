import { writeStateFile } from '../scripts/state-files.mjs';
import { json, optional, pathFor, recoveryPath } from './node-state.mjs';

export const NODE_DIAGNOSTIC_LIMITS = Object.freeze({ bytes: 8192, events: 32, attempts: 1000000 });
const OPERATIONS = ['join', 'leave', 'recover'];
const STAGES = ['preflight', 'preparing', 'enrolling', 'applying', 'starting', 'verifying', 'stopping', 'releasing', 'restoring', 'resolving', 'complete'];
const STATUSES = ['running', 'succeeded', 'failed'];
const REASONS = ['dns', 'timeout', 'tls', 'network', 'authorization', 'busy', 'conflict', 'storage', 'configuration', 'service', 'recovery_pending', 'operation_failed'];
const timestamp = value => value === null || Number.isSafeInteger(value) && value > 0;
const reason = value => value === null || REASONS.includes(value);
const event = value => value && timestamp(value.at) && value.at !== null && OPERATIONS.includes(value.operation) && STAGES.includes(value.stage) && STATUSES.includes(value.status) && reason(value.reason);

function validate(value) {
  if (value?.version !== 1 || !event({ ...value, at: value.updatedAt }) || !Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > NODE_DIAGNOSTIC_LIMITS.attempts ||
    !timestamp(value.lastSuccessAt) || !timestamp(value.lastReadyAt) || typeof value.recoveryPending !== 'boolean' || !Array.isArray(value.history) || value.history.length > NODE_DIAGNOSTIC_LIMITS.events || !value.history.every(event)) throw Error('节点诊断状态无效');
  // Construct a whitelist rather than exporting arbitrary private-file fields.
  return { version: 1, operation: value.operation, stage: value.stage, status: value.status, reason: value.reason, attempts: value.attempts,
    updatedAt: value.updatedAt, lastSuccessAt: value.lastSuccessAt, lastReadyAt: value.lastReadyAt, recoveryPending: value.recoveryPending,
    history: value.history.map(({ at, operation, stage, status, reason }) => ({ at, operation, stage, status, reason })) };
}

async function snapshot(root) {
  const text = await optional(pathFor(root, 'diagnostics.json'), NODE_DIAGNOSTIC_LIMITS.bytes);
  return { text, value: text === null ? null : validate(JSON.parse(text)) };
}

export async function readNodeDiagnostics(root) {
  try {
    const { value } = await snapshot(root);
    return value ? { available: true, ...value, retryCount: value.attempts - 1 } : { available: true, status: 'unknown', stage: 'unknown', retryCount: 0, lastSuccessAt: null, lastReadyAt: null, history: [] };
  } catch { return { available: false, reason: 'diagnostics_unavailable' }; }
}

function failureReason(error, stage, pending) {
  const code = error.code || error.cause?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ETIMEDOUT', 'ABORT_ERR', 'ERR_HTTP_REQUEST_TIMEOUT'].includes(code) || ['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  if (typeof code === 'string' && (/^ERR_TLS_/.test(code) || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'network';
  if ([401, 403].includes(error.status)) return 'authorization';
  if ([429, 503].includes(error.status)) return 'busy';
  if (error.status === 409) return 'conflict';
  if (['ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'EIO'].includes(code)) return 'storage';
  if (pending) return 'recovery_pending';
  if (stage === 'preflight' || stage === 'preparing') return 'configuration';
  if (stage === 'starting' || stage === 'stopping') return 'service';
  return 'operation_failed';
}

// Called only while the deployment lease is held. One private <=8 KiB state,
// <=32 fixed-schema events; no raw errors, URLs, workspace paths or secrets.
export async function trackNodeOperation(root, operation, work) {
  if (!OPERATIONS.includes(operation)) throw Error('节点诊断操作无效');
  let previous = { text: null, value: null }, available = true;
  try { previous = await snapshot(root); } catch { available = false; }
  const old = previous.value, state = { version: 1, operation, stage: 'preflight', status: 'running', reason: null,
    attempts: old?.operation === operation && old.status !== 'succeeded' ? Math.min(old.attempts + 1, NODE_DIAGNOSTIC_LIMITS.attempts) : 1,
    updatedAt: Date.now(), lastSuccessAt: old?.lastSuccessAt || null, lastReadyAt: old?.lastReadyAt || null, recoveryPending: false, history: old?.history || [] };
  let text = previous.text;
  const save = async () => {
    state.updatedAt = Date.now();
    state.history = [...state.history, { at: state.updatedAt, operation, stage: state.stage, status: state.status, reason: state.reason }].slice(-NODE_DIAGNOSTIC_LIMITS.events);
    if (!available) return;
    const next = json(validate(state));
    if (Buffer.byteLength(next) > NODE_DIAGNOSTIC_LIMITS.bytes) { available = false; return; }
    try { await writeStateFile(pathFor(root, 'diagnostics.json'), next, { expected: text, committed: () => { text = next; } }); }
    catch { available = false; }
  };
  const report = async stage => { if (!STAGES.includes(stage)) throw Error('节点诊断阶段无效'); state.stage = stage; await save(); };
  await save();
  try {
    const result = await work(report);
    state.stage = 'complete'; state.status = 'succeeded'; state.lastSuccessAt = Date.now();
    if (result.entryReady === true) state.lastReadyAt = state.lastSuccessAt;
    await save();
    if (!available) {
      const warning = '节点诊断状态无法保存，操作结果不受影响';
      if (Array.isArray(result.warnings)) result.warnings.push(warning);
      else result.warning = [result.warning, warning].filter(Boolean).join('；');
    }
    return result;
  } catch (error) {
    state.status = 'failed';
    try { state.recoveryPending = await optional(recoveryPath(root), 262144) !== null; } catch { state.recoveryPending = true; }
    state.reason = failureReason(error, state.stage, state.recoveryPending);
    await save(); throw error;
  }
}
