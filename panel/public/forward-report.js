const CODES = new Set(["rtc_disabled", "rtc_waiting_helper", "rtc_connecting", "rtc_unavailable", "rtc_negotiation_failed", "rtc_ice_timeout", "rtc_dtls_timeout", "rtc_auth_timeout", "rtc_health_timeout", "rtc_channel_failed", "rtc_busy", "rtc_draining", "pair_invalid", "pair_expired", "pair_used", "pairing_timeout", "local_port_in_use", "local_listen_failed", "reverse_upgrade_required", "reverse_denied", "reverse_confirm_timeout", "reverse_port_in_use", "reverse_listen_failed", "reverse_stream_timeout", "stopped", "signed_out", "authorization_expired", "authorization_revoked", "helper_disconnected", "helper_reconnecting", "helper_stopped", "resume_busy", "resume_expired", "resume_authorization_invalid", "heartbeat_timeout", "server_stopping", "protocol_error", "target_unavailable", "target_timeout", "target_disconnected", "tcp_peer_stalled", "connection_limit", "rate_limit", "buffer_limit", "stream_authorization_invalid"]);
const labels = { pending: '等待配对', connecting: '助手握手/确认中', recovering: '助手离线，等待恢复', active: '助手在线' };
export function forwardFaultArea(code = '') {
  if (!code) return '无';
  if (/^rtc_/.test(code)) return '直连协商（中转仍可用）';
  if (/^(target_|serial_)/.test(code)) return '助手/服务器到目标设备';
  if (/^(pair_|authorization_|signed_out|resume_authorization)/.test(code)) return '配对或登录授权';
  if (/^(helper_|heartbeat_|resume_|network_)/.test(code)) return '助手与服务器通道';
  if (/^(connection_limit|rate_limit|buffer_limit|tcp_peer_stalled)/.test(code)) return '连接或流量限制';
  return code === 'stopped' ? '用户停止' : code === 'server_stopping' ? '面板维护' : '握手或协议';
}
// Copy only enumerated status and numeric metrics; never serialize API objects.
export function forwardReport(data, now = Date.now()) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const date = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : '未知';
  const code = value => CODES.has(value) ? value : '无/未知';
  const rows = ['Codex Cloud 映射诊断 v1', '采集时间：' + date(now), '地址、端口、设备名、映射标识及凭据均已省略。',
    '每映射并发上限：' + number(data.maxConnections) + '；助手 20 条上限仅限制状态提示，不限制连接。',
    '锁屏保留授权；来源登录退出/到期/撤销、明确停止及面板重启会结束映射。'];
  for (const [i, item] of (data.mappings || []).slice(0, 4).entries()) {
    const direct = item.direct || {}, target = item.targetStatus?.state;
    rows.push('映射 ' + (i + 1) + '：' + (item.direction === 'reverse' ? '服务器访问本地设备' : '本机访问服务器'),
      '状态：' + (labels[item.state] || '未知') + '；创建：' + date(item.createdAt),
      '授权：' + (item.authorization?.createdHere ? '本次登录' : '其他登录') + ' / ' + (item.authorization?.role === 'temporary' ? '临时账号' : '管理员') + '；到期：' + date(item.authorization?.expiresAt),
      '连接：' + number(item.connections) + '；直连：' + number(item.directConnections) + '；发送/接收 B：' + number(item.sent) + '/' + number(item.received),
      '新连接路径：' + (direct.available ? '加密直连' : '中转') + '；直连原因：' + code(direct.reason) + '；RTT ms：' + number(direct.rttMs),
      '目标：' + ({ reachable: '最近成功', failed: '最近失败', unverified: '尚未验证' }[target] || '未知') + '；错误：' + code(item.errorCode) + '；环节：' + forwardFaultArea(item.errorCode),
      '恢复截止：' + date(item.recoverUntil));
  }
  for (const item of (data.recent || []).slice(0, 8)) rows.push('最近结束：' + date(item.endedAt) + ' / ' + code(item.code) + ' / ' + forwardFaultArea(item.code));
  return rows.join('\n').slice(0, 32768);
}
