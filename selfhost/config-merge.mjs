import { parseEnv } from 'node:util';

export const PANEL_ENV_KEYS = Object.freeze(['PUBLIC_ORIGIN', 'ENTRY_BASE_PATH', 'SELFHOST_NODE_CONFIG_FILE', 'SHARED_ENTRY', 'NODE_ID', 'SELFHOST_CA_FILE']);

function fields(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('Panel 环境配置超过 64 KiB 或格式无效');
  const parsed = parseEnv(text), records = new Map(); let offset = 0;
  while (offset < text.length) {
    const lineEnd = text.indexOf('\n', offset), end = lineEnd < 0 ? text.length : lineEnd;
    const match = text.slice(offset, end).replace(/\r$/, '').match(/^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*)(.*)$/);
    if (!match) { offset = end + 1; continue; }
    const key = match[2], start = offset + match[1].length, quote = text[start];
    let valueEnd, recordEnd = end;
    if (['"', "'", '`'].includes(quote)) {
      const close = text.indexOf(quote, start + 1);
      if (close < 0) { if (PANEL_ENV_KEYS.includes(key)) throw Error('接管字段引号未闭合：' + key); break; }
      valueEnd = close + 1;
      const nextLine = text.indexOf('\n', valueEnd); recordEnd = nextLine < 0 ? text.length : nextLine;
    } else {
      const comment = text.indexOf('#', start);
      valueEnd = comment >= start && comment < end ? comment : end;
      while (valueEnd > start && /[ \t\r]/.test(text[valueEnd - 1])) valueEnd--;
    }
    if (PANEL_ENV_KEYS.includes(key)) {
      if (records.has(key)) throw Error('.env 包含重复的 ' + key + '，请先人工消除冲突');
      const suffix = text.slice(valueEnd, recordEnd);
      if (!/^[ \t\r]*(?:#[^\n]*)?$/.test(suffix) || !Object.hasOwn(parsed, key)) throw Error('接管字段格式无法安全合并：' + key);
      records.set(key, { offset, end: recordEnd < text.length ? recordEnd + 1 : recordEnd, start, valueEnd, raw: text.slice(start, valueEnd), suffix, value: parseEnv(text.slice(offset, recordEnd))[key] });
    }
    offset = recordEnd + 1;
  }
  for (const key of PANEL_ENV_KEYS) if (Object.hasOwn(parsed, key) && (!records.has(key) || records.get(key).value !== parsed[key])) throw Error('接管字段格式无法安全合并：' + key);
  return { parsed, records };
}

export function mergeEnvironment(current, base, desired, alternatives = []) {
  const present = fields(current), previous = fields(base), wanted = fields(desired), allowed = [previous, ...alternatives.map(fields)];
  const same = (a, b, key) => Object.hasOwn(a.parsed, key) === Object.hasOwn(b.parsed, key) && a.parsed[key] === b.parsed[key];
  const changes = []; let append = '';
  for (const key of PANEL_ENV_KEYS) {
    if (same(present, wanted, key)) continue;
    if (!allowed.some(value => same(present, value, key))) throw Error('Panel 环境接管字段已被修改，未覆盖：' + key);
    const record = present.records.get(key), target = wanted.records.get(key);
    if (record && target) changes.push({ start: record.start, end: record.valueEnd, value: target.raw });
    else if (record) {
      const comment = record.suffix.trim();
      changes.push({ start: record.offset, end: record.end, value: comment.startsWith('#') ? comment + '\n' : '' });
    } else if (target) append += key + '=' + target.raw + '\n';
  }
  let result = current;
  for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.value + result.slice(change.end);
  if (append) result += (result && !result.endsWith('\n') ? '\n' : '') + append;
  if (Buffer.byteLength(result) > 65536) throw Error('合并后的 Panel 环境配置超过 64 KiB');
  const parsed = parseEnv(result);
  for (const key of PANEL_ENV_KEYS) if (Object.hasOwn(parsed, key) !== Object.hasOwn(wanted.parsed, key) || parsed[key] !== wanted.parsed[key]) throw Error('合并后的接管字段无效：' + key);
  for (const key of new Set([...Object.keys(present.parsed), ...Object.keys(parsed)])) {
    if (!PANEL_ENV_KEYS.includes(key) && (Object.hasOwn(present.parsed, key) !== Object.hasOwn(parsed, key) || present.parsed[key] !== parsed[key])) throw Error('合并会更改非接管字段，未覆盖');
  }
  return result;
}

function workbench(text) {
  if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > 4096)) throw Error('登录说明超过大小限制');
  const records = [...(text || '').matchAll(/^工作台：[^\r\n]*/gm)];
  if (records.length > 1) throw Error('登录说明包含重复的工作台地址');
  return records[0];
}

export function mergeCredentials(current, base, desired, alternatives = []) {
  const record = workbench(current), target = workbench(desired);
  if (record?.[0] === target?.[0]) return current;
  if (![base, ...alternatives].some(text => workbench(text)?.[0] === record?.[0])) throw Error('Panel 登录说明接管字段已被修改，未覆盖');
  let result = current || '';
  if (record) result = result.slice(0, record.index) + (target?.[0] || '') + result.slice(record.index + record[0].length);
  else if (target) result += (result && !result.endsWith('\n') ? '\n' : '') + target[0] + '\n';
  if (Buffer.byteLength(result) > 4096) throw Error('合并后的登录说明超过大小限制');
  return result || (desired === null ? null : '');
}
