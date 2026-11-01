export function viewportSize(value, maximum) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['width', 'height'].includes(key)) ||
      !['width', 'height'].every(key => Number.isInteger(value[key]) && value[key] >= 160 && value[key] <= 8192)) throw new Error('窗口宽高必须为 160–8192 的整数');
  const scale = Math.min(1, maximum.width / value.width, maximum.height / value.height);
  return { width: Math.min(maximum.width, Math.max(160, Math.floor(value.width * scale / 8) * 8)),
    height: Math.min(maximum.height, Math.max(160, Math.floor(value.height * scale / 8) * 8)) };
}

export function parseScreen(text) {
  const match = text.match(/^Screen 0: minimum \d+ x \d+, current (\d+) x (\d+), maximum (\d+) x (\d+)$/m);
  const outputs = [...text.matchAll(/^(\S+) connected\b/gm)];
  if (!match || outputs.length !== 1 || outputs[0][1] !== 'screen') throw new Error('该显示不支持安全的窗口适配');
  const [width, height, maxWidth, maxHeight] = match.slice(1).map(Number);
  if ([width, height].some(value => value < 160 || value > 4096) || [maxWidth, maxHeight].some(value => value < 320 || value > 4096)) throw new Error('虚拟显示尺寸超出范围');
  return { actual: { width, height }, maximum: { width: maxWidth, height: maxHeight } };
}

export function createViewportResizer(run) {
  let state = { supported: false }, active = false, refreshing;
  async function inspect(runner = run) {
    const screen = await runner('xrandr', ['--query']);
    return { text: screen, ...parseScreen(screen) };
  }
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { const screen = await inspect(); if (!active) state = { supported: true, maximum: screen.maximum, actual: screen.actual }; }
      catch { if (!active) state = { supported: false }; }
      return { ...state };
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  return { refresh, status: () => ({ ...state }), async resize(value) {
    if (active) throw new Error('窗口适配正在进行');
    active = true;
    const deadline = Date.now() + 5000;
    const bounded = (command, args) => {
      if (Date.now() >= deadline) throw new Error('窗口适配超时');
      return run(command, args, { timeout: Math.min(1000, deadline - Date.now()) });
    };
    try {
      const screen = await inspect(bounded), size = viewportSize(value, screen.maximum);
      if (size.width === screen.actual.width && size.height === screen.actual.height) return { actual: size, maximum: screen.maximum };
      const current = screen.text.match(/^\s+(codex-viewport-[ab])\s+[^\n]*\*/m)?.[1];
      const next = current === 'codex-viewport-a' ? 'codex-viewport-b' : 'codex-viewport-a';
      // Two reusable mode slots bound X server resources, including failures.
      await bounded('xrandr', ['--delmode', 'screen', next]).catch(() => {});
      await bounded('xrandr', ['--rmmode', next]).catch(() => {});
      const { width: w, height: h } = size;
      await bounded('xrandr', ['--newmode', next, ((w + 160) * (h + 45) * 60 / 1000000).toFixed(3),
        String(w), String(w + 48), String(w + 80), String(w + 160), String(h), String(h + 3), String(h + 8), String(h + 45), '-hsync', '+vsync']);
      await bounded('xrandr', ['--addmode', 'screen', next]);
      await bounded('xrandr', ['--output', 'screen', '--mode', next, '--fb', `${w}x${h}`]);
      const after = await inspect(bounded);
      if (after.actual.width !== w || after.actual.height !== h) throw new Error('显示尺寸尚未更新');
      state = { supported: true, maximum: after.maximum, actual: after.actual };
      return { actual: after.actual, maximum: after.maximum };
    } finally { active = false; }
  } };
}
