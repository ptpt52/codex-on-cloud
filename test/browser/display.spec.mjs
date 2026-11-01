import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

function observeInput(page) {
  const stats = { connections: 0, pointers: 0, keys: 0, resizes: 0, lastPointer: null };
  page.on('websocket', socket => {
    stats.connections++;
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload)) return;
      if (payload.length === 6 && payload[0] === 5) {
        stats.pointers++;
        stats.lastPointer = { x: payload.readUInt16BE(2), y: payload.readUInt16BE(4) };
      }
      if (payload.length === 8 && payload[0] === 4) stats.keys++;
      if (payload[0] === 251) stats.resizes++;
    });
  });
  return stats;
}
async function login(page, origin = '/') {
  await page.goto(origin);
  await page.getByLabel('密码', { exact: true }).fill('demo_password_for_tests');
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
  await expect(page.frameLocator('#desktop-frame').locator('#status')).toBeHidden();
  await expect(page.locator('#zoom-label')).toHaveText(/^\d+%$/);
}
const canvasOf = page => page.frameLocator('#desktop-frame').locator('#screen canvas');
const widthOf = async page => Math.round((await canvasOf(page).boundingBox()).width);

test('display controls scale locally, preserve input coordinates and remember preferences', async ({ page }, info) => {
  const stats = observeInput(page);
  await login(page);
  const initial = await widthOf(page);
  expect(initial).toBeLessThan(1600);
  await page.locator('#actual-size-button').click();
  await expect.poll(() => widthOf(page)).toBe(1600);
  await expect(page.locator('#zoom-label')).toHaveText('100%');
  await page.locator('#zoom-in-button').click();
  await expect.poll(() => widthOf(page)).toBe(2000);
  await expect(page.locator('#zoom-label')).toHaveText('125%');

  const stage = await page.locator('#desktop-stage').boundingBox();
  const canvas = await canvasOf(page).boundingBox();
  const point = { x: Math.round(stage.x + stage.width / 2), y: Math.round(stage.y + stage.height / 2) };
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => stats.pointers).toBeGreaterThan(0);
  expect(Math.abs(stats.lastPointer.x - (point.x - canvas.x) / 1.25)).toBeLessThanOrEqual(1);
  expect(Math.abs(stats.lastPointer.y - (point.y - canvas.y) / 1.25)).toBeLessThanOrEqual(1);

  await page.locator('#toggle-input-button').click();
  await expect(page.locator('#input-dock')).toBeHidden();
  expect((await page.locator('#desktop-stage').boundingBox()).height).toBeGreaterThan(stage.height + 100);
  expect(stats.connections).toBe(1);
  expect(stats.resizes).toBe(0);
  expect(await canvasOf(page).evaluate(canvas => [canvas.width, canvas.height])).toEqual([1600, 1600]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  if (info.project.name === 'desktop') {
    await page.locator('#fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await expect(page.getByRole('group', { name: '桌面显示控制' })).toBeVisible();
    await page.evaluate(() => document.exitFullscreen());
  }
  await page.locator('#pan-button').click();
  await page.reload();
  await expect(page.locator('#zoom-label')).toHaveText('125%');
  await expect.poll(() => widthOf(page)).toBe(2000);
  await expect(page.locator('#toggle-input-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#input-dock')).toBeHidden();
  await expect(page.locator('#pan-button')).toHaveAttribute('aria-pressed', 'true');
  expect((await page.evaluate(() => localStorage.getItem('codex-cloud.display.v1'))).length).toBeLessThanOrEqual(256);
  await page.locator('#zoom-out-button').click();
  await expect.poll(() => widthOf(page)).toBe(1600);
  await page.locator('#fit-button').click();
  await expect.poll(async () => {
    const container = await page.locator('#desktop-stage').boundingBox();
    return Math.abs((await widthOf(page)) - Math.min(container.width, container.height));
  }).toBeLessThanOrEqual(1);
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 844, height: 390 } : { width: 1100, height: 760 });
  await expect.poll(async () => {
    const rect = await canvasOf(page).boundingBox();
    const container = await page.locator('#desktop-stage').boundingBox();
    return rect.width <= container.width + 1 && rect.height <= container.height + 1;
  }).toBe(true);
  expect(stats.resizes).toBe(0);
  await page.screenshot({ path: `test-results/${info.project.name}-display-controls.png`, fullPage: true });
});

test('pan mode handles dragging and taps without sending remote pointer or keyboard input', async ({ page, context }, info) => {
  const stats = observeInput(page);
  await login(page);
  await canvasOf(page).click();
  await expect.poll(() => stats.pointers).toBeGreaterThan(0);
  await page.locator('#actual-size-button').click();
  await expect.poll(() => widthOf(page)).toBe(1600);
  await page.locator('#pan-button').click();
  const layer = page.frameLocator('#desktop-frame').locator('#pan-layer');
  await expect(layer).toBeVisible();
  await page.waitForTimeout(100); // Drain a mouse move that may precede entering pan mode.
  const before = { pointers: stats.pointers, keys: stats.keys };
  const viewport = page.frameLocator('#desktop-frame').locator('#viewport');
  const scrollBefore = await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]);
  const rect = await layer.boundingBox();
  const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
  if (info.project.name === 'mobile') {
    const client = await context.newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 12, y: y - step * 16 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await layer.tap();
    await client.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y - 80, { steps: 5 });
    await page.mouse.up();
    await layer.click();
    await page.mouse.wheel(0, 60);
  }
  await layer.press('ArrowDown');
  await layer.press('a');
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBefore[1]);
  await page.waitForTimeout(100);
  expect({ pointers: stats.pointers, keys: stats.keys }).toEqual(before);
  await page.locator('#pan-button').click();
  await expect(layer).toBeHidden();
  await page.locator('#fit-button').click();
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-pressed', 'true');
  await canvasOf(page).click();
  await expect.poll(() => stats.pointers).toBeGreaterThan(before.pointers);
  expect(stats.connections).toBe(1);
  expect(stats.resizes).toBe(0);
});

test('a framebuffer reconnect restores display controls without replaying input', async ({ page }) => {
  const app = await fixture({ rfb: true, password: 'demo_password_for_tests' });
  const stats = observeInput(page);
  let writes = 0;
  page.on('request', request => { if (/\/api\/(paste|key|terminal)$/.test(request.url()) && request.method() === 'POST') writes++; });
  try {
    await login(page, app.config.origin);
    await page.locator('#actual-size-button').click();
    await expect.poll(() => widthOf(page)).toBe(1600);
    await page.locator('#pan-button').click();
    await expect(page.frameLocator('#desktop-frame').locator('#pan-layer')).toBeVisible();
    await page.getByLabel('要粘贴到桌面的文字').fill('断线后不要自动发送这条指令');
    const baseline = { pointers: stats.pointers, keys: stats.keys };
    app.disconnectViewers();
    await expect.poll(() => stats.connections, { timeout: 10000 }).toBe(2);
    await expect(page.frameLocator('#desktop-frame').locator('#status')).toBeHidden();
    await expect.poll(() => widthOf(page)).toBe(1600);
    await expect(page.frameLocator('#desktop-frame').locator('#pan-layer')).toBeVisible();
    await expect(page.locator('#zoom-label')).toHaveText('100%');
    await expect(page.locator('#pan-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('要粘贴到桌面的文字')).toHaveValue('断线后不要自动发送这条指令');
    expect(writes).toBe(0);
    expect({ pointers: stats.pointers, keys: stats.keys }).toEqual(baseline);
  } finally { await app.close(); }
});

test('invalid saved display preferences fall back to a usable interactive view', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ zoom: 100000, pan: true, collapsed: true })));
  await login(page);
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pan-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#input-dock')).toBeVisible();
  await expect(page.frameLocator('#desktop-frame').locator('#pan-layer')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function observeScaleReports(page) {
  await page.addInitScript(() => window.addEventListener('message', event => {
    if (event.data?.type !== 'codex-desktop-view') return;
    if (window.holdScaleReports) { window.heldScaleReport = event.data; event.stopImmediatePropagation(); }
    else window.latestScaleReport = event.data;
  }, true));
}

test('rapid manual zoom uses the requested scale while viewer reports are delayed', async ({ page }) => {
  const app = await fixture({ rfb: true, password: 'demo_password_for_tests' });
  const stats = observeInput(page);
  try {
    await observeScaleReports(page); await login(page, app.config.origin);
    await page.evaluate(() => { window.holdScaleReports = true; });
    await page.locator('#actual-size-button').click();
    await page.locator('#zoom-in-button').click();
    await expect(page.locator('#zoom-label')).toHaveText('125%');
    await page.locator('#zoom-in-button').click();
    await expect(page.locator('#zoom-label')).toHaveText('156%');
    await page.locator('#zoom-out-button').click();
    await expect(page.locator('#zoom-label')).toHaveText('125%');
    await expect.poll(() => widthOf(page)).toBe(2000);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).zoom)).toBe(1.25);
    for (let i = 0; i < 4; i++) if (!await page.locator('#zoom-in-button').isDisabled()) await page.locator('#zoom-in-button').click();
    await expect(page.locator('#zoom-label')).toHaveText('200%');
    await expect(page.locator('#zoom-in-button')).toBeDisabled();
    expect(stats.connections).toBe(1); expect(stats.keys).toBe(0); expect(stats.resizes).toBe(0); expect(app.inputCalls).toHaveLength(0);
  } finally { await app.close(); }
});

test('fit zoom waits for its matching report and ignores a late manual-scale report', async ({ page }) => {
  const app = await fixture({ rfb: true, password: 'demo_password_for_tests' });
  try {
    await observeScaleReports(page); await login(page, app.config.origin);
    await page.locator('#actual-size-button').click();
    await expect.poll(() => page.evaluate(() => window.latestScaleReport?.scale)).toBe(1);
    const stale = await page.evaluate(() => window.latestScaleReport);
    await page.evaluate(() => { window.holdScaleReports = true; });
    await page.locator('#fit-button').click();
    await expect(page.locator('#zoom-in-button')).toBeDisabled();
    await expect(page.locator('#zoom-label')).toHaveText('—');
    await expect.poll(() => page.evaluate(() => window.heldScaleReport?.revision ?? -1)).toBeGreaterThan(stale.revision);
    const current = await page.evaluate(() => window.heldScaleReport);
    const deliver = report => page.evaluate(data => {
      window.holdScaleReports = false;
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: document.getElementById('desktop-frame').contentWindow, data }));
    }, report);
    await deliver(stale);
    await expect(page.locator('#zoom-label')).toHaveText('—');
    await expect(page.locator('#zoom-in-button')).toBeDisabled();
    await deliver(current);
    await expect(page.locator('#zoom-in-button')).toBeEnabled();
    await page.locator('#zoom-in-button').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).zoom)).toBe(Math.round(current.scale * 1.25 * 100) / 100);
    expect(app.inputCalls).toHaveLength(0);
  } finally { await app.close(); }
});
