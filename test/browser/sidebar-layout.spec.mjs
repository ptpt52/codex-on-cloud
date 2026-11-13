import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Wide-screen layout; phone regression cases run in mobile-edges');
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function setup(page, { mode = 'terminal', count = 2, webrtc = false, fastConnect = webrtc, username = 'admin', desktopHook } = {}) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const app = await fixture({ mode, username, rfb: true, seamless: true, maxTerminals: 8, webrtc, fastConnect, desktopHook });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: `研发任务 ${n}：客户现场调试`, view: 'terminal' });
  await page.addInitScript(() => {
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    let Native;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Native,
      set: Value => { Native = class extends Value { constructor(...args) { super(...args); window.sidebarTerminal = this; } }; } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('在线');
  await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', 'sidebar');
  if (mode === 'terminal') await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible();
  return { app, errors, frame: page.frames().find(frame => /\/(terminal|desktop)\/index.html/.test(frame.url())) };
}
function output(app, text) {
  app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
}

test('desktop sidebar activates existing tasks and preserves the viewer and per-target drafts', async ({ page }) => {
  const activated = [];
  const { app, errors } = await setup(page, { mode: 'desktop', count: 3, desktopHook: (command, args) => { if (command === 'xdotool' && args[0] === 'windowactivate') activated.push(args.at(-1)); } });
  const opens = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') opens.push(request.postDataJSON()); });
  try {
    const original = await app.controls.listTerminals(), source = await page.locator('#desktop-frame').getAttribute('src'), connections = app.vncConnections;
    await expect(page.locator('#terminal-tabs')).toHaveAttribute('aria-label', '桌面终端任务');
    await expect(page.locator('#terminal-tabs [data-terminal-choice]')).toHaveCount(3);
    await expect(page.locator('#terminal-tabs [data-terminal-choice=new]')).toHaveCount(0);
    await openInput(page); await page.locator('#mobile-input').fill('当前窗口草稿'); await closePanels(page);
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await expect(page.locator('#terminal-tabs [data-terminal-choice=aux1]')).toHaveAttribute('aria-selected', 'true');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue(''); await page.locator('#mobile-input').fill('辅助任务草稿'); await closePanels(page);
    await page.setViewportSize({ width: 1440, height: 480 }); await expect(page.locator('#terminal-session-button')).toBeVisible();
    await page.locator('#terminal-session-button').click(); await expect(page.locator('#terminal-switch-title')).toHaveText('选择桌面终端');
    await page.locator('#terminal-switch-list [data-terminal-choice=main]').click(); await expect(page.locator('#input-terminal')).toHaveValue('main');
    await page.setViewportSize({ width: 900, height: 900 }); await expect(page.locator('#terminal-session-bar')).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.locator('#terminal-tabs')).toBeVisible();
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('辅助任务草稿');
    await page.locator('#input-terminal').selectOption(''); await expect(page.locator('#mobile-input')).toHaveValue('当前窗口草稿');
    expect(opens).toEqual([]); expect(activated).toEqual(['1001', '999', '1001']);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(connections);
    expect(await app.controls.listTerminals()).toEqual(original); expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('desktop task activation reports an unswitched input target when drafts fill during the request', async ({ page }) => {
  await page.addInitScript(() => {
    if (location.pathname !== '/') return;
    sessionStorage.setItem('codex-cloud.terminals.v1', JSON.stringify({ version: 1, selection: { id: '', token: '' },
      drafts: Array.from({ length: 9 }, (_, i) => ({ id: 'main', token: `%${100 + i}:${4000 + i}`, text: `保留的旧草稿 ${i}` })) }));
  });
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let opens = 0;
  const { app, errors } = await setup(page, { mode: 'desktop', count: 2, desktopHook: async (command, args) => {
    if (command === 'xdotool' && args[0] === 'windowactivate') { opens++; entered(); await hold; }
  } });
  try {
    await openInput(page);
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await started;
    await page.locator('#mobile-input').fill('请求期间新增的草稿');
    await expect(page.locator('#draft-status')).toContainText('草稿空间已满');
    release();
    await expect(page.locator('#toast')).toContainText('输入助手目标尚未切换');
    await expect(page.locator('#input-terminal')).toHaveValue('');
    await expect(page.locator('#mobile-input')).toHaveValue('请求期间新增的草稿');
    await expect(page.locator('#terminal-tabs [data-terminal-choice=aux1]')).toHaveAttribute('aria-selected', 'false');
    expect(opens).toBe(1); idle(app, errors);
  } finally { release(); await app.close(); }
});
const geometry = page => page.locator('#desktop-frame').boundingBox();
const attachedHistory = page => page.evaluate(() => {
  const panel = document.getElementById('history-tools').getBoundingClientRect(), terminal = document.getElementById('desktop-frame').getBoundingClientRect();
  return Math.abs(panel.left - terminal.left) <= 1 && Math.abs(panel.top - terminal.top) <= 1 && Math.abs(panel.width - terminal.width) <= 1;
});
const idle = (app, errors) => {
  expect(errors).toEqual([]); expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
};

for (const mode of ['terminal', 'desktop']) test(`${mode}: one sidebar contains every toolbar and gives the viewer full height`, async ({ page }, info) => {
  const { app, errors, frame } = await setup(page, { mode, username: mode === 'desktop' ? 'operations-administrator' : 'admin' });
  try {
    await expect(page.locator('.topbar')).toBeHidden(); await expect(page.locator('.desktop-toolbar')).toBeHidden();
    const viewer = await geometry(page);
    expect(viewer.y).toBeLessThanOrEqual(10); expect(viewer.height).toBeGreaterThanOrEqual(880);
    if (mode === 'desktop') {
      const sidebar = await page.locator('#workspace-sidebar').boundingBox();
      const gap = viewer.x - sidebar.x - sidebar.width;
      expect(gap).toBeGreaterThan(4); expect(gap).toBeLessThanOrEqual(16);
    }
    for (const id of ['toggle-controls-button', 'toggle-input-button', 'files-button', 'forward-button', 'connection-button', 'fullscreen-button', 'logout-button']) {
      const button = page.locator(`#workspace-sidebar #${id}`); await expect(button).toBeVisible();
      const box = await button.boundingBox(); expect(box.x + box.width).toBeLessThan(viewer.x);
    }
    if (mode === 'terminal') {
      await expect(frame.locator('#terminal-tools')).toHaveCount(0);
      const history = await page.locator('#sidebar-history').boundingBox();
      const gap = viewer.x - history.x - history.width;
      expect(gap).toBeGreaterThan(0); expect(gap).toBeLessThanOrEqual(12);
      await expect(page.locator('#terminal-tabs')).toHaveAttribute('aria-orientation', 'vertical');
      output(app, '\x1b[2J\x1b[H\x1b[32mptpt52@ubuntu\x1b[0m:~/Sources/codex-on-cloud$ codex\r\n\r\nCodex · 研发工作区\r\n\r\n> 请分析客户现场的网络连接问题\r\n\r\n任务继续运行，切换布局不会重新连接终端。\r\n');
      await expect.poll(() => frame.evaluate(() => window.sidebarTerminal.buffer.active.getLine(2)?.translateToString(true))).toContain('Codex');
    }
    const before = await geometry(page);
    await openTools(page); expect(await geometry(page)).toEqual(before);
    await expect(page.locator('#workspace-layout')).toHaveValue('sidebar');
    await closePanels(page); await page.screenshot({ path: info.outputPath(`sidebar-${mode}.png`) });
    expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('layout changes preserve the live iframe and draft, and remember only the browser preference', async ({ page }) => {
  const { app, errors, frame } = await setup(page);
  try {
    const connections = app.terminalConnections;
    await frame.evaluate(() => window.originalSidebarTerminal = window.sidebarTerminal);
    await page.evaluate(() => window.originalSidebarFrame = document.getElementById('desktop-frame'));
    await openInput(page); await page.locator('#mobile-input').fill('尚未发送的中文草稿'); await closePanels(page);
    await openTools(page); await page.locator('#workspace-layout').selectOption('top');
    await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', 'top');
    await expect(page.locator('.topbar #files-button')).toBeVisible(); await expect(frame.locator('#terminal-tools')).toBeVisible();
    await page.locator('#workspace-layout').selectOption('sidebar'); await closePanels(page);
    await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible();
    expect(await page.evaluate(() => window.originalSidebarFrame === document.getElementById('desktop-frame'))).toBe(true);
    expect(await frame.evaluate(() => window.originalSidebarTerminal === window.sidebarTerminal)).toBe(true);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('尚未发送的中文草稿'); await closePanels(page);
    await page.locator('#sidebar-top-layout').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).workspaceLayout)).toBe('top');
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', 'top');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('尚未发送的中文草稿'); idle(app, errors);
  } finally { await app.close(); }
});

test('paging and find state changes keep the sidebar history block and its buttons in place', async ({ page }) => {
  const { app, errors } = await setup(page);
  try {
    const connections = app.terminalConnections;
    const bounds = () => page.evaluate(() => Object.fromEntries(['sidebar-history', 'history-program', 'history-up', 'history-down', 'history-latest', 'history-tools-toggle', 'history-status-row', 'sidebar-actions', 'desktop-frame'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect(); return [id, { x: box.x, y: box.y, width: box.width, height: box.height }];
    })));
    for (const height of [900, 480]) {
      await page.setViewportSize({ width: 1440, height });
      await page.locator('#history-program').scrollIntoViewIfNeeded();
      const before = await bounds();
      for (const program of [true, false, true, false]) {
        await page.locator('#history-program').click();
        await expect(page.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
        expect(await bounds()).toEqual(before);
      }
      await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeVisible();
      expect(await bounds()).toEqual(before);
      await page.locator('#history-query').fill('未匹配的关键词');
      await expect(page.locator('#history-find-state')).toContainText('无匹配');
      expect(await bounds()).toEqual(before);
      await page.locator('#history-tools-close').click(); await expect(page.locator('#history-tools')).toBeHidden();
      expect(await bounds()).toEqual(before);
      // Closing find preserves the snapshot; return explicitly to live mode.
      await page.locator('#history-latest').click();
      await expect(page.locator('#history-state')).toContainText('本地回看');
      expect(await bounds()).toEqual(before);
    }
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('all sessions stay reachable vertically and the phone layout returns without reconnecting', async ({ page }) => {
  const { app, errors, frame } = await setup(page, { count: 8 });
  try {
    const tabs = page.locator('#terminal-tabs [data-terminal-choice]'); await expect(tabs).toHaveCount(9);
    await tabs.first().focus(); await page.keyboard.press('ArrowDown'); await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press('End'); await expect(tabs.nth(7)).toBeFocused(); await expect(tabs.nth(7)).toBeInViewport();
    await page.setViewportSize({ width: 1440, height: 480 });
    await expect(page.locator('#terminal-session-button')).toBeVisible(); await expect(page.locator('#terminal-tabs')).toBeHidden();
    await page.locator('#terminal-session-button').click();
    const choice = page.locator('#terminal-switch-list [data-terminal-choice=aux7]');
    await choice.focus(); await expect(choice).toBeInViewport(); await choice.click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux7');
    await expect(page.locator('#connection-status')).toContainText('在线');
    const connections = app.terminalConnections;
    for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 480 }, { width: 1440, height: 240 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', size.width < 1200 ? 'top' : 'sidebar');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
      if (size.width < 1200) {
        await expect(frame.locator('#terminal-tools')).toBeVisible(); await expect(page.locator('#terminal-session-button')).toBeVisible();
      } else {
        await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible();
        await page.locator('#logout-button').scrollIntoViewIfNeeded(); await expect(page.locator('#logout-button')).toBeInViewport();
        expect((await geometry(page)).height).toBeGreaterThan(size.height - 25);
      }
    }
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('the sidebar uses a full picker only below three visible tab rows and restores focus, selection and drafts', async ({ page }) => {
  const { app, errors, frame } = await setup(page, { count: 8, fastConnect: true });
  try {
    const connections = app.terminalConnections, original = await app.controls.listTerminals();
    await openInput(page); await page.locator('#mobile-input').fill('主终端未发送的草稿'); await closePanels(page);
    await frame.evaluate(() => window.pickerOriginalTerminal = window.sidebarTerminal);
    const tab = id => page.locator(`#terminal-tabs [data-terminal-choice=${id}]`), picker = page.locator('#terminal-session-button');
    const cutoff = await page.locator('#terminal-tabs').evaluate(tabs => {
      const third = tabs.children[2].getBoundingClientRect(), viewport = tabs.getBoundingClientRect();
      return Math.ceil(innerHeight + third.bottom + parseFloat(getComputedStyle(tabs).paddingBottom) - viewport.bottom);
    });
    await page.setViewportSize({ width: 1440, height: cutoff + 2 });
    await expect(picker).toBeHidden(); await expect(tab('aux2')).toBeInViewport(); await tab('aux2').focus();
    const sidebarHeight = await page.locator('.sidebar-sessions').boundingBox();
    await page.setViewportSize({ width: 1440, height: cutoff - 2 });
    await expect(picker).toBeVisible(); await expect(page.locator('#terminal-tabs')).toBeHidden(); await expect(picker).toBeFocused();
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    expect(Math.abs((await page.locator('.sidebar-sessions').boundingBox()).height - sidebarHeight.height)).toBeLessThanOrEqual(5);
    await page.locator('#terminal-session-actions').click(); await expect(page.locator('#terminal-action-title')).toHaveText(original.terminals[0].name);
    await page.locator('#terminal-action-dismiss').click();
    await picker.click(); await expect(page.locator('#terminal-switch-title')).toHaveText('选择终端');
    await expect(page.locator('#terminal-switch-list [data-terminal-choice]:visible')).toHaveCount(9);
    await expect(page.locator('#terminal-switch-list [data-terminal-choice=new]')).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#terminal-switch-dialog')).toBeHidden(); await expect(picker).toBeHidden();
    await expect(tab('main')).toBeFocused();
    expect(await frame.evaluate(() => window.sidebarTerminal === window.pickerOriginalTerminal)).toBe(true);
    expect(app.terminalConnections).toBe(connections);
    await page.setViewportSize({ width: 1440, height: cutoff - 2 }); await expect(picker).toBeVisible(); await picker.click();
    await page.locator('#terminal-switch-list [data-terminal-choice=aux7]').click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux7'); await expect(page.locator('#connection-status')).toContainText('在线');
    await expect(picker).toBeEnabled();
    await expect(picker).toContainText(original.terminals[7].name);
    // Explicitly selecting another task can attach a new legacy viewer.
    // Adapting that viewer's controls must keep its new connection intact.
    const selectedFrame = page.frames().find(frame => /\/terminal\/index.html/.test(frame.url())), selectedConnections = app.terminalConnections;
    await selectedFrame.evaluate(() => window.pickerOriginalTerminal = window.sidebarTerminal);
    await picker.click(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#terminal-switch-dialog')).toBeHidden(); await expect(picker).toBeHidden();
    await expect(tab('aux7')).toBeFocused();
    await expect(tab('aux7')).toBeInViewport();
    expect(await selectedFrame.evaluate(() => window.sidebarTerminal === window.pickerOriginalTerminal)).toBe(true);
    expect(app.terminalConnections).toBe(selectedConnections);
    await tab('main').click(); await expect(page.locator('#input-terminal')).toHaveValue('main');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端未发送的草稿');
    expect(await app.controls.listTerminals()).toEqual(original);
    expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('find and paging remain usable through responsive changes, terminal switches and reconnect', async ({ page }, info) => {
  const { app, errors, frame } = await setup(page);
  try {
    output(app, '\x1b[2J\x1b[HSEARCH-中文\r\n');
    await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-tools')).toBeVisible();
    await expect.poll(() => attachedHistory(page)).toBe(true);
    await page.locator('#history-query').fill('SEARCH');
    await expect(page.locator('#history-find-state')).toContainText('1/1');
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#history-query')).toHaveValue('SEARCH');
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.locator('#history-query')).toHaveValue('SEARCH');
    await expect.poll(() => attachedHistory(page)).toBe(true);
    const before = await geometry(page); await page.locator('#history-tools-close').click(); expect(await geometry(page)).toEqual(before);
    // Closing find preserves the history snapshot. Resume the live terminal
    // explicitly before sending input, independently of the search debounce.
    await expect(frame.locator('#history-archive')).toBeVisible();
    await page.locator('#history-latest').click(); await expect(frame.locator('#history-archive')).toBeHidden();
    await expect(page.locator('#connection-status')).toContainText('在线');
    await frame.locator('.xterm-helper-textarea').press('x');
    await expect.poll(() => app.terminalInputs.map(item => item.text)).toEqual(['x']);
    await page.locator('#history-program').click(); await page.locator('#history-up').click();
    await expect.poll(() => app.terminalInputs.map(item => item.text)).toEqual(['x', '\x1b[5~']);
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible(); await page.locator('#history-program').click();
    const connections = app.terminalConnections; app.disconnectTerminals();
    await expect.poll(() => app.terminalConnections).toBe(connections + 1); await expect(page.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#sidebar-history #history-tools-toggle')).toBeVisible();
    await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeVisible();
    await page.screenshot({ path: info.outputPath('sidebar-find.png') });
    expect(app.terminalInputs.map(item => item.text)).toEqual(['x', '\x1b[5~']); idle(app, errors);
  } finally { await app.close(); }
});

test('fullscreen retains the sidebar actions and the same terminal connection', async ({ page }) => {
  const { app, errors } = await setup(page);
  try {
    const connections = app.terminalConnections;
    await page.locator('#fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await expect(page.locator('#workspace-sidebar')).toBeVisible(); await openTools(page); await closePanels(page);
    await page.locator('#fullscreen-button').click(); await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('standby mode swaps keep the toolbar with the active viewer and never expose parked controls', async ({ page }) => {
  const { app, errors } = await setup(page, { mode: 'desktop' });
  try {
    await openTools(page); await page.locator('#mode-standby').check(); await closePanels(page);
    await expect(page.locator('#standby-frame')).toHaveAttribute('src', /\/terminal\/index.html/);
    await expect.poll(() => app.terminalConnections).toBe(1);
    const connections = { terminal: app.terminalConnections, vnc: app.vncConnections };
    for (let n = 0; n < 2; n++) for (const mode of ['terminal', 'desktop']) {
      await page.locator(`#${mode}-mode`).click(); await page.locator('#accept-confirmation').click();
      await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
      if (mode === 'terminal') {
        await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible();
        await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeVisible(); await page.locator('#history-tools-close').click();
      } else await expect(page.locator('#sidebar-history #terminal-tools')).toHaveCount(0);
    }
    expect({ terminal: app.terminalConnections, vnc: app.vncConnections }).toEqual(connections);
    expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await app.close(); }
});

test('takeover removes adopted controls and find tools until the page explicitly claims the terminal again', async ({ page, context }) => {
  const { app, errors } = await setup(page); const second = await context.newPage();
  try {
    await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeVisible();
    await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#sidebar-history #terminal-tools')).toHaveCount(0); await expect(page.locator('#history-tools')).toHaveCount(0);
    await expect(page.locator('#toggle-input-button')).toBeHidden();
    await page.locator('#takeover-button').click(); await expect(page.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#sidebar-history #terminal-tools')).toHaveCount(1); await expect(page.locator('#history-tools-toggle')).toBeVisible();
    expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { await second.close(); await app.close(); }
});

test('a direct terminal keeps sidebar paging and layout changes when HTTPS polling is unavailable', async ({ page }) => {
  const { app, errors } = await setup(page, { webrtc: true });
  try {
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const source = await page.locator('#desktop-frame').getAttribute('src'), connections = app.terminalConnections;
    await page.route('**/api/state', route => route.abort());
    await openTools(page); await page.locator('#workspace-layout').selectOption('top');
    await page.locator('#workspace-layout').selectOption('sidebar'); await closePanels(page);
    await page.locator('#history-program').click(); await page.locator('#history-up').click();
    await expect.poll(() => app.terminalInputs.map(item => item.text)).toEqual(['\x1b[5~']);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(app.terminalConnections).toBe(connections); idle(app, errors);
  } finally { await app.close(); }
});

test('refreshing the saved sidebar waits for delayed terminal modules before adopting their controls', async ({ page }) => {
  const { app, errors } = await setup(page);
  let release, delayed = false;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await openTools(page); await page.locator('#workspace-layout').selectOption('top');
    await page.locator('#workspace-layout').selectOption('sidebar'); await closePanels(page);
    const connections = app.terminalConnections;
    const sessionsBefore = await page.locator('.sidebar-sessions').boundingBox();
    await page.route('**/terminal-history.js*', async route => { delayed = true; await gate; await route.continue(); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => delayed).toBe(true);
    const terminal = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await expect(terminal.locator('#terminal-tools')).toHaveCount(1);
    // A normal poll or viewport event can render the outer page while the
    // iframe's dependent modules are still waiting for their network response.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(terminal.locator('#terminal-tools')).toHaveCount(1);
    await expect(page.locator('#sidebar-history #terminal-tools')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await page.locator('.sidebar-sessions').boundingBox()).height - sessionsBefore.height)).toBeLessThanOrEqual(1);
    release();
    await expect(page.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#sidebar-history #terminal-tools')).toBeVisible();
    expect(Math.abs((await page.locator('.sidebar-sessions').boundingBox()).height - sessionsBefore.height)).toBeLessThanOrEqual(1);
    await page.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeVisible();
    expect(app.terminalConnections).toBe(connections + 1);
    expect(app.terminalInputs).toEqual([]); idle(app, errors);
  } finally { release(); await app.close(); }
});
