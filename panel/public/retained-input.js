// iPad desktop-mode Safari identifies itself as a Mac. Scope the retained
// editing context to Apple's touch input; other IMEs keep their existing path.
export function appleTouchInput() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export const RETAINED_INPUT_LIMITS = Object.freeze({ bytes: 32768, erase: 512 });
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The DOM value is the editable document, not another chunk to append. Speech
// input may replace its previous result many times, including after a pause.
export function retainedEdit(previous, next) {
  if (typeof next !== 'string' || new TextEncoder().encode(next).length > RETAINED_INPUT_LIMITS.bytes || /[\x00-\x08\x0b-\x1f\x7f]/.test(next)) throw Error('输入超过 32 KiB 或包含控制字符，请使用输入助手。');
  const a = Array.from(segmenter.segment(previous), value => value.segment), b = Array.from(segmenter.segment(next), value => value.segment);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const erase = a.length - prefix;
  if (erase > RETAINED_INPUT_LIMITS.erase) throw Error('本次听写改写范围过大，输入已暂停，请核对远端后使用输入助手。');
  return { erase, text: b.slice(prefix).join('') };
}

export function createRetainedInput({ read, apply, rejected }) {
  let previous = '', timer, generation = 0;
  function flush() {
    clearTimeout(timer); timer = undefined;
    const next = read();
    try {
      const edit = retainedEdit(previous, next);
      if (!edit.erase && !edit.text) return true;
      if (!apply(edit)) return false;
      previous = next; return true;
    } catch (error) { rejected(error.message); return false; }
  }
  return { flush, finalize() {
    clearTimeout(timer); const current = generation;
    timer = setTimeout(() => { timer = undefined; if (current === generation) flush(); }, 0);
  }, reset() { generation++; clearTimeout(timer); timer = undefined; previous = ''; },
  get value() { return previous; } };
}

// Capture before xterm's textarea handlers. One native DOM edit must have one
// writer; in particular keyCode 229 must not start xterm's delayed diff too.
export function attachRetainedTerminal({ field, allowed, apply, hasSelection, clearSelection, notice, blurred = () => {} }) {
  let composing = false, external = false, failed = false, pasted = false;
  const handled = new Set(), listeners = [];
  const model = createRetainedInput({ read: () => field.value, apply: edit => {
    const paste = pasted; pasted = false; return apply({ ...edit, paste });
  }, rejected: text => {
    failed = true; model.reset(); field.blur(); notice(text);
  } });
  const reset = (clear = true) => { model.reset(); composing = false; pasted = false; handled.clear(); if (clear) field.value = ''; };
  const on = (name, callback) => { const listener = event => { if (event.target === field) callback(event); }; window.addEventListener(name, listener, true); listeners.push([name, listener]); };
  const prepare = () => { if (external || hasSelection()) { clearSelection(); reset(); external = false; } };
  on('focus', () => { reset(!hasSelection()); external = hasSelection(); failed = false; });
  on('blur', () => { reset(); blurred(); });
  on('keydown', event => {
    if (!allowed() || failed) return;
    const code = event.code || event.key;
    const editing = composing || event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'Unidentified', 'Compose'].includes(event.key) || [...event.key].length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey || !event.code && event.key === 'Backspace';
    if (editing) {
      prepare();
      if (handled.size < 64) handled.add(code); event.stopImmediatePropagation();
      if (event.key === 'Backspace' && !event.code && !composing && !field.value) { event.preventDefault(); apply({ erase: 1, text: '' }); }
      return;
    }
    if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && hasSelection()) { model.reset(); external = true; return; }
      if (!model.flush()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      reset();
    }
  });
  on('keypress', event => { if (allowed() && !event.ctrlKey && !event.altKey && !event.metaKey) event.stopImmediatePropagation(); });
  on('keyup', event => { if (handled.delete(event.code || event.key)) event.stopImmediatePropagation(); });
  on('compositionstart', event => {
    if (!allowed() || failed) return;
    prepare(); pasted = false; event.stopImmediatePropagation();
    if (model.flush()) composing = true;
  });
  on('compositionupdate', event => { if (composing) event.stopImmediatePropagation(); });
  on('compositionend', event => {
    event.stopImmediatePropagation();
    if (!composing || !allowed() || failed) return;
    composing = false; model.finalize();
  });
  on('paste', event => {
    if (!allowed() || failed) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    prepare(); pasted = true; event.stopImmediatePropagation();
    // Let the browser perform the DOM edit and emit input. xterm's paste
    // handler would write separately and clear the dictation context.
  });
  on('beforeinput', event => { if (allowed() && !failed && !composing && !event.isComposing) prepare(); });
  on('input', event => {
    event.stopImmediatePropagation();
    if (!allowed() || failed || composing || event.isComposing || document.activeElement !== field) return;
    if (event.inputType === 'insertFromPaste') pasted = true;
    model.flush(); pasted = false;
  });
  return { update() {
    if (!allowed()) { reset(); if (document.activeElement === field) field.blur(); }
  }, dispose() { reset(); for (const [name, callback] of listeners) window.removeEventListener(name, callback, true); },
  get active() { return document.activeElement === field && (!!model.value || composing); } };
}
