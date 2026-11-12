// Local IME capture, with a single in-flight paste and a bounded ordering buffer.
// Nothing survives a focus/connection change or gets retried after an unknown result.
export function createDesktopInput({ screen, field, status, current, allowed, paste, changed }) {
  const MAX_EVENTS = 64, MAX_BYTES = 32768;
  let enabled = true, composing = false, generation = 0, pending, queue = [], bytes = 0, sequence = 0, lastCommit = '', compositionInput = false, reported = '', printable, blockedReason = '';
  const suppressed = new Set(), accepted = new Set(), delivered = new Map();
  const ready = () => enabled && allowed() && !!current() && !document.hidden && navigator.onLine;
  const show = text => { status.textContent = text; status.hidden = !text; };
  const release = () => {
    // Release only keys this bridge delivered. Synthetic blur changes actual
    // canvas focus in Firefox; a key-up preserves focus and avoids stuck keys.
    const canvas = current();
    for (const value of delivered.values()) canvas?.dispatchEvent(new KeyboardEvent('keyup', { ...value, repeat: false }));
    delivered.clear();
  };
  const report = () => { const busy = !!pending || !!queue.length, key = `${composing}:${busy}`; if (key !== reported) { reported = key; changed({ composing, busy }); } };
  const clearField = () => { field.value = ''; field.classList.remove('composing'); };
  function cancel(message = '') {
    generation++; queue = []; bytes = 0; composing = false; lastCommit = ''; compositionInput = false; printable = undefined; suppressed.clear(); accepted.clear(); blockedReason = message; clearField(); release(); report(); show(message);
  }
  function fail(message) { cancel(message); }
  function drain() {
    if (pending || !queue.length) return;
    if (!ready() || document.activeElement !== field) return cancel();
    while (queue.length && queue[0].kind === 'key') {
      const entry = queue.shift();
      if (entry.canvas !== current() || entry.generation !== generation) return cancel();
      const code = entry.value.code || entry.value.key;
      if (entry.type === 'keyup') delivered.delete(code);
      else if (delivered.size < 64) delivered.set(code, entry.value);
      entry.canvas.dispatchEvent(new KeyboardEvent(entry.type, entry.value));
    }
    if (!queue.length) { report(); return; }
    const entry = queue.shift();
    if (entry.canvas !== current() || entry.generation !== generation) return cancel();
    const request = pending = entry; show('正在输入文字…'); report();
    void paste(entry.text, ++sequence).then(result => {
      if (request.generation !== generation || request.canvas !== current()) return;
      if (result?.outcome !== 'success') return fail(result?.outcome === 'rejected' ? '文字未发送，请重新输入。' : '文字输入结果未知，请先核对远端；不会自动重发。');
      show(document.activeElement === field ? '键盘控制远程桌面 · 支持本机输入法' : '');
    }, () => { if (request.generation === generation) fail('文字输入结果未知，请先核对远端；不会自动重发。'); }).finally(() => {
      if (pending !== request) return;
      pending = undefined; bytes = Math.max(0, bytes - request.size); report(); drain();
    });
  }
  function enqueue(entry) {
    if (pending && pending.generation !== generation) return show(blockedReason || '上一次输入尚未结束，本次内容未发送，请稍后重试。');
    if (!ready()) return show('输入暂不可用，请稍后重新输入。');
    if (blockedReason && !(entry.kind === 'key' && entry.type === 'keyup')) { blockedReason = ''; show('键盘控制远程桌面 · 支持本机输入法'); }
    if (queue.length + (pending ? 1 : 0) >= MAX_EVENTS || bytes + (entry.size || 0) > MAX_BYTES) return fail('输入超过缓冲上限，部分内容未发送，请核对远端。');
    bytes += entry.size || 0; queue.push({ ...entry, canvas: current(), generation }); drain(); report();
  }
  function text(value) {
    if (!value) return;
    if (sequence >= 2147483647) return fail('输入会话已达到上限，请刷新页面。');
    if (typeof value !== 'string' || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return fail('文字包含不支持的控制字符，未发送。');
    const size = new TextEncoder().encode(value).length;
    if (size > MAX_BYTES) return fail('一次输入不能超过 32 KiB，请使用输入助手分段粘贴。');
    enqueue({ kind: 'text', text: value, size });
  }
  function key(event) {
    event.stopImmediatePropagation();
    const code = event.code || event.key;
    if (event.key.length > 64 || code.length > 64) { event.preventDefault(); return fail('按键数据无效，未发送。'); }
    const releaseAccepted = event.type === 'keyup' && accepted.has(code);
    if (!releaseAccepted && (event.isComposing || composing || event.keyCode === 229 || ['Process', 'Dead', 'Compose', 'Unidentified'].includes(event.key))) {
      if (event.type === 'keydown' && suppressed.size < 64) suppressed.add(code);
      if (event.type === 'keyup') suppressed.delete(code);
      return;
    }
    if (!releaseAccepted && suppressed.has(code)) { if (event.type === 'keyup') suppressed.delete(code); event.preventDefault(); return; }
    const value = { key: event.key, code: event.code, location: event.location, repeat: event.repeat, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      modifierAltGraph: event.getModifierState('AltGraph'), modifierCapsLock: event.getModifierState('CapsLock'), modifierNumLock: event.getModifierState('NumLock'), bubbles: true, cancelable: true };
    lastCommit = '';
    // The first pinyin key and full-width punctuation may not yet be marked as
    // composing on keydown. Let the browser decide what text it commits first.
    if (event.type === 'keydown' && [...event.key].length === 1 && !event.metaKey && ((!event.ctrlKey && !event.altKey) || value.modifierAltGraph)) {
      printable = { value, code, canvas: current(), generation }; return;
    }
    event.preventDefault(); printable = undefined;
    if (event.type === 'keyup') accepted.delete(code);
    else if (accepted.size < 64) accepted.add(code);
    enqueue({ kind: 'key', type: event.type, value });
  }
  field.addEventListener('keydown', key); field.addEventListener('keyup', key);
  field.addEventListener('compositionstart', () => {
    if (!ready()) return cancel();
    composing = true; lastCommit = ''; printable = undefined; release(); field.classList.add('composing'); show('正在使用本机输入法选字'); report();
  });
  field.addEventListener('compositionend', event => {
    if (!composing) return clearField();
    composing = false; report(); lastCommit = event.data || ''; text(lastCommit); clearField(); report();
  });
  field.addEventListener('beforeinput', event => {
    compositionInput = composing || event.isComposing || /Composition/.test(event.inputType);
  });
  field.addEventListener('input', event => {
    const echo = compositionInput || /Composition/.test(event.inputType); compositionInput = false;
    if (composing || event.isComposing) return;
    const value = field.value;
    // Only the final composition event is an echo. A following insertText or
    // paste with the same characters is a separate user input, even immediately.
    if (echo && lastCommit && (value === lastCommit || !value && event.data === lastCommit)) { lastCommit = ''; clearField(); return; }
    lastCommit = '';
    const candidate = printable; printable = undefined;
    if (candidate && candidate.generation === generation && candidate.canvas === current() && value === candidate.value.key && /^[\x20-\x7e]$/.test(value)) {
      if (accepted.size < 64) accepted.add(candidate.code);
      enqueue({ kind: 'key', type: 'keydown', value: candidate.value });
    } else if (value) { release(); text(value); }
    clearField();
  });
  field.addEventListener('blur', () => cancel());
  field.addEventListener('focus', () => { if (ready()) show('键盘控制远程桌面 · 支持本机输入法'); });
  const focus = () => {
    if (!ready()) return false;
    if (document.activeElement === field) return true;
    if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) return false;
    field.focus({ preventScroll: true }); return true;
  };
  screen.addEventListener('mouseup', event => {
    if (event.button !== 0 || event.target !== current() || !ready()) return;
    if (composing) cancel();
    field.style.left = `${Math.max(0, Math.min(innerWidth - Math.min(240, innerWidth - 16) - 8, event.clientX))}px`;
    field.style.top = `${Math.max(0, Math.min(innerHeight - 32, event.clientY))}px`;
    focus();
  }, true);
  screen.addEventListener('mousedown', event => {
    if (pending || queue.length) { event.preventDefault(); event.stopImmediatePropagation(); show('文字正在输入，请稍后再点击桌面。'); }
    else if (composing) cancel();
  }, true);
  window.addEventListener('blur', () => cancel());
  window.addEventListener('offline', () => cancel('连接已断开，未完成的输入不会自动重发。'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { focus, cancel, update(value = enabled) {
    enabled = value;
    if (!ready()) { cancel(); if (document.activeElement === field) field.blur(); }
  }, get composing() { return composing; }, get busy() { return !!pending || !!queue.length; } };
}
