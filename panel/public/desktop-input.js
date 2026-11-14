// Local IME capture, with a single in-flight paste and a bounded ordering buffer.
// Nothing survives a focus/connection change or gets retried after an unknown result.
import { appleTouchInput, createRetainedInput, retainedEdit } from './retained-input.js';

export function createDesktopInput({ screen, field, status, current, allowed, paste, changed }) {
  const MAX_EVENTS = 64, MAX_BYTES = 32768;
  const TOUCH_ANCHOR = '\u200b'; // Gives soft keyboards a local character to delete.
  let enabled = true, composing = false, touch = false, generation = 0, pending, queue = [], bytes = 0, sequence = 0, lastCommit = '', compositionInput = false, handledInput = '', reported = '', printable, blockedReason = '';
  let retained, run = 0, lastRun = -1, lastFocus;
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
  const report = () => { const busy = !!pending || !!queue.length, key = `${composing}:${busy}:${touch}`; if (key !== reported) { reported = key; changed({ composing, busy, touch }); } };
  const clearField = () => {
    field.value = touch ? TOUCH_ANCHOR : ''; field.classList.remove('composing');
    if (touch) field.setSelectionRange(field.value.length, field.value.length);
  };
  const fieldText = () => touch && field.value.startsWith(TOUCH_ANCHOR) ? field.value.slice(1) : field.value;
  const restoreField = () => { field.value = (touch ? TOUCH_ANCHOR : '') + retained.value; field.setSelectionRange(field.value.length, field.value.length); };
  if (appleTouchInput()) retained = createRetainedInput({ read: fieldText, apply: edit => {
    const accepted = text(edit.text, edit.erase);
    // A rejected DOM edit must not be picked up by a later composition after
    // the old request finishes. It is discarded exactly like an abandoned key.
    if (!accepted) boundary();
    return accepted;
  }, rejected: fail });
  function boundary() { retained?.reset(); run++; clearField(); }
  const validFocus = value => value && typeof value.window === 'string' && /^[1-9]\d{0,9}$/.test(value.window) && ['terminal', 'application'].includes(value.target);
  function cancel(message = '') {
    const dismiss = touch && document.activeElement === field;
    generation++; queue = []; bytes = 0; composing = touch = false; lastCommit = ''; compositionInput = false; handledInput = ''; printable = undefined; suppressed.clear(); accepted.clear(); retained?.reset(); run++; lastRun = -1; lastFocus = undefined; clearField(); release();
    if (dismiss) field.blur();
    blockedReason = message; report(); show(message);
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
    let edit;
    if (entry.retained && entry.run === lastRun) {
      if (!validFocus(lastFocus)) return fail('后台未确认原输入窗口，连续输入已暂停，请更新后台后重试。');
      edit = { erase: entry.erase, focus: lastFocus };
    } else if (entry.erase) return fail('原输入上下文已变化，文字未改写，请先核对远端。');
    const request = pending = entry; show('正在输入文字…'); report();
    void paste(entry.text, ++sequence, edit).then(result => {
      if (request.generation !== generation || request.canvas !== current()) return;
      if (result?.outcome !== 'success') return fail(result?.outcome === 'rejected' ? '文字未发送，请重新输入。' : '文字输入结果未知，请先核对远端；不会自动重发。');
      if (entry.retained) { lastRun = entry.run; lastFocus = result.focus; }
      show(document.activeElement === field ? '键盘控制远程桌面 · 支持本机输入法' : '');
    }, () => { if (request.generation === generation) fail('文字输入结果未知，请先核对远端；不会自动重发。'); }).finally(() => {
      if (pending !== request) return;
      pending = undefined; bytes = Math.max(0, bytes - request.size); report(); drain();
    });
  }
  function enqueue(entry) {
    if (pending && pending.generation !== generation) { show(blockedReason || '上一次输入尚未结束，本次内容未发送，请稍后重试。'); return false; }
    if (!ready()) { show('输入暂不可用，请稍后重新输入。'); return false; }
    if (blockedReason && !(entry.kind === 'key' && entry.type === 'keyup')) { blockedReason = ''; show('键盘控制远程桌面 · 支持本机输入法'); }
    const last = queue.at(-1);
    if (entry.retained && last?.retained && last.run === entry.run && last.generation === generation && last.canvas === current()) {
      // Only replace an unstarted revision of this same editable document.
      // Acknowledged/in-flight writes and intervening keys never get replayed.
      let edit;
      try { edit = retainedEdit(last.before, entry.next); } catch (error) { fail(error.message); return false; }
      const size = new TextEncoder().encode(edit.text).length;
      if (bytes - last.size + size > MAX_BYTES) { fail('输入超过缓冲上限，请核对远端。'); return false; }
      bytes += size - last.size;
      if (!edit.text && !edit.erase) queue.pop();
      else Object.assign(last, edit, { size, next: entry.next });
      report(); return true;
    }
    if (queue.length + (pending ? 1 : 0) >= MAX_EVENTS || bytes + (entry.size || 0) > MAX_BYTES) return fail('输入超过缓冲上限，部分内容未发送，请核对远端。');
    const activeGeneration = generation;
    bytes += entry.size || 0; queue.push({ ...entry, canvas: current(), generation }); drain(); report(); return generation === activeGeneration;
  }
  function text(value, erase = 0) {
    if (!value && !erase) return true;
    if (sequence >= 2147483647) return fail('输入会话已达到上限，请刷新页面。');
    if (typeof value !== 'string' || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return fail('文字包含不支持的控制字符，未发送。');
    const size = new TextEncoder().encode(value).length;
    if (size > MAX_BYTES) return fail('一次输入不能超过 32 KiB，请使用输入助手分段粘贴。');
    return enqueue({ kind: 'text', text: value, size, erase, retained: !!retained, run,
      ...(retained ? { before: retained.value, next: fieldText() } : {}) });
  }
  function press(name) {
    const code = ['Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(name) ? name : undefined;
    if (!code || !ready() || composing || document.activeElement !== field) return false;
    if (retained) { if (!retained.flush()) return false; boundary(); }
    const value = { key: name, code, bubbles: true, cancelable: true };
    enqueue({ kind: 'key', type: 'keydown', value }); enqueue({ kind: 'key', type: 'keyup', value }); return true;
  }
  function softAction(type) {
    if (type === 'deleteContentBackward') press('Backspace');
    // Candidate confirmation is not a command submission. Soft-keyboard line
    // breaks use the explicit Enter button; hardware Enter keeps its key path.
    else show('请点快捷栏 Enter 提交；长文本可在输入助手中编辑。');
    if (!retained || type === 'deleteContentBackward') clearField();
    else restoreField();
  }
  const softActionType = type => ['deleteContentBackward', 'insertLineBreak', 'insertParagraph'].includes(type);
  function key(event) {
    event.stopImmediatePropagation();
    const code = event.code || event.key;
    if (event.key.length > 64 || code.length > 64) { event.preventDefault(); return fail('按键数据无效，未发送。'); }
    // Virtual keyboards can report an ordinary-looking key as well as a DOM
    // edit. Without a physical code, handle these through beforeinput/input
    // only; otherwise one tap can delete twice or submit a candidate.
    if (touch && !event.code && ['Enter', 'Backspace'].includes(event.key)) return;
    const releaseAccepted = event.type === 'keyup' && accepted.has(code);
    if (!releaseAccepted && (event.isComposing || composing || event.keyCode === 229 || ['Process', 'Dead', 'Compose', 'Unidentified'].includes(event.key))) {
      if (event.type === 'keydown' && suppressed.size < 64) suppressed.add(code);
      if (event.type === 'keyup') suppressed.delete(code);
      return;
    }
    if (!releaseAccepted && suppressed.has(code)) { if (event.type === 'keyup') suppressed.delete(code); event.preventDefault(); return; }
    if (retained && event.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
      if (!retained.flush()) { event.preventDefault(); return; }
      boundary();
    }
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
    if (retained && document.activeElement !== field) return;
    if (!ready()) return cancel();
    if (retained && !retained.flush()) return;
    composing = true; lastCommit = ''; printable = undefined; release(); field.classList.add('composing'); show('正在使用本机输入法选字'); report();
  });
  field.addEventListener('compositionend', event => {
    if (!composing) { if (!retained) clearField(); return; }
    if (retained) { composing = false; field.classList.remove('composing'); report(); retained.finalize(); return; }
    composing = false; report(); lastCommit = event.data || ''; text(lastCommit); clearField(); report();
  });
  field.addEventListener('beforeinput', event => {
    compositionInput = composing || event.isComposing || /Composition/.test(event.inputType);
    handledInput = '';
    if (touch && !compositionInput && softActionType(event.inputType) && !(retained && event.inputType === 'deleteContentBackward' && retained.value) && event.cancelable) {
      event.preventDefault(); handledInput = event.inputType; softAction(event.inputType);
    }
  });
  field.addEventListener('input', event => {
    if (retained && document.activeElement !== field) return;
    const echo = compositionInput || /Composition/.test(event.inputType); compositionInput = false;
    if (composing || event.isComposing) return;
    if (touch && !echo && softActionType(event.inputType) && !(retained && event.inputType === 'deleteContentBackward' && retained.value)) {
      if (handledInput !== event.inputType) softAction(event.inputType);
      handledInput = ''; clearField(); return;
    }
    handledInput = '';
    const value = fieldText();
    // Only the final composition event is an echo. A following insertText or
    // paste with the same characters is a separate user input, even immediately.
    if (echo && lastCommit && (value === lastCommit || !value && event.data === lastCommit)) { lastCommit = ''; clearField(); return; }
    lastCommit = '';
    const candidate = printable; printable = undefined;
    if (candidate && candidate.generation === generation && candidate.canvas === current() && value === candidate.value.key && /^[\x20-\x7e]$/.test(value)) {
      if (accepted.size < 64) accepted.add(candidate.code);
      enqueue({ kind: 'key', type: 'keydown', value: candidate.value });
    } else if (retained) { release(); retained.flush(); if (touch && !field.value) restoreField(); return; }
    else if (value) { release(); text(value); }
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
  return { focus, cancel, press, openTouch() {
    if (!ready() || pending && pending.generation !== generation) return false;
    if (!touch) { touch = true; clearField(); }
    // Called synchronously by the viewer's button, preserving the user gesture
    // needed by touch browsers to present their own system keyboard.
    field.focus({ preventScroll: true }); report(); return document.activeElement === field;
  }, closeTouch() { cancel(); field.blur(); }, update(value = enabled) {
    enabled = value;
    if (!ready()) { cancel(); if (document.activeElement === field) field.blur(); }
  }, get composing() { return composing; }, get busy() { return !!pending || !!queue.length; }, get touch() { return touch; } };
}
