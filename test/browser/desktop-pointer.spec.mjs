import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function setup(page, options = {}) {
  // The focused phone layout can show almost the whole 1600×3200 framebuffer.
  // Use a shorter browser window here so local scrolling has room to move.
  await page.setViewportSize({ ...page.viewportSize(), height: 600 });
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1600, height: 3200 }, ...options });
  const pointers = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (Buffer.isBuffer(payload) && payload.length === 6 && payload[0] === 5) pointers.push({ buttons: payload[1], x: payload.readUInt16BE(2), y: payload.readUInt16BE(4) });
  }));
  await page.goto(app.config.origin);
  await page.locator('#password').fill(app.config.password);
  await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  const frame = page.frameLocator('#desktop-frame');
  await expect(frame.locator('#screen canvas')).toBeVisible();
  await expect(frame.locator('#pointer-controls')).toBeVisible();
  return { app, pointers, frame };
}

async function trackpad(page) {
  await page.locator('#toggle-controls-button').click();
  await page.locator('#pointer-mode').selectOption('trackpad');
  await page.locator('#close-controls-button').click();
  await expect(page.frameLocator('#desktop-frame').locator('#pointer-left')).toBeVisible();
}

async function swipe(client, x, y, { two = false, dx = 36, dy = -80 } = {}) {
  const points = step => [{ x: x + dx * step / 5, y: y + dy * step / 5, id: 1 }, ...(two ? [{ x: x + 24 + dx * step / 5, y: y + dy * step / 5, id: 2 }] : [])];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
  for (let step = 1; step <= 5; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step) });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('scroll target switches between local viewport motion and remote RFB wheel events', async ({ page }) => {
  const { app, pointers, frame } = await setup(page);
  try {
    const bounds = await page.locator('#desktop-stage').boundingBox();
    const x = bounds.x + bounds.width * 0.4, y = bounds.y + bounds.height * 0.4;
    const viewport = frame.locator('#viewport');
    await page.mouse.move(x, y);
    await expect.poll(() => pointers.length).toBeGreaterThan(0);
    const before = pointers.length;
    await page.mouse.wheel(0, 180);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    expect(pointers.length).toBe(before);
    const top = await viewport.evaluate(element => element.scrollTop);
    await frame.locator('#pointer-scroll').click();
    await expect(frame.locator('#pointer-scroll')).toHaveText('滚动程序');
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 180);
    await expect.poll(() => pointers.filter(value => value.buttons === 16).length).toBeGreaterThan(0);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(top);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).scrollTarget)).toBe('remote');
    await page.reload();
    await expect(frame.locator('#pointer-scroll')).toHaveText('滚动程序');
    expect(app.inputCalls).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('relative touch moves without clicking and supports left, right and explicitly held drag', async ({ page, context }) => {
  const { app, pointers, frame } = await setup(page);
  const client = await context.newCDPSession(page);
  try {
    await trackpad(page);
    const bounds = await page.locator('#desktop-stage').boundingBox();
    const x = Math.round(bounds.x + bounds.width * 0.4), y = Math.round(bounds.y + bounds.height * 0.45);
    await swipe(client, x, y, { dx: 36, dy: 20 });
    await expect(frame.locator('#touch-cursor')).toBeVisible();
    await expect.poll(() => pointers.length).toBeGreaterThan(0);
    expect(pointers.every(value => value.buttons === 0)).toBe(true);
    const moved = pointers.at(-1), scale = (await frame.locator('#screen canvas').boundingBox()).width / 1600;
    expect(moved.x).toBeGreaterThan(800 + 20 / scale);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => pointers.filter(value => value.buttons === 1).length).toBe(1);
    const start = pointers.length;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }, { x: x + 24, y, id: 2 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => pointers.slice(start).filter(value => value.buttons === 4).length).toBe(1);
    expect(pointers.slice(start).some(value => value.buttons === 1)).toBe(false);
    await frame.locator('#pointer-drag').click();
    await expect(frame.locator('#pointer-drag')).toHaveAttribute('aria-pressed', 'true');
    expect(pointers.at(-1).buttons).toBe(1);
    await expect(frame.locator('#noVNC_mouse_capture_elem')).toBeHidden();
    await swipe(client, x, y, { dx: 30, dy: 15 });
    expect(pointers.at(-1).buttons).toBe(1);
    // Moving focus to the parent releases the held button on the old stream.
    await page.locator('#toggle-controls-button').click();
    await expect.poll(() => pointers.at(-1).buttons).toBe(0);
    await page.locator('#pan-button').click();
    await page.locator('#close-controls-button').click();
    await expect(frame.locator('#pointer-controls')).toBeHidden();
    const before = pointers.length;
    await swipe(client, x, y);
    expect(pointers.length).toBe(before);
    expect(app.inputCalls).toEqual([]);
  } finally { await client.detach(); await app.close(); }
});

test('two-finger trackpad scrolling respects the target and a cancelled touch never clicks', async ({ page, context }) => {
  const { app, pointers, frame } = await setup(page);
  const client = await context.newCDPSession(page);
  try {
    await trackpad(page);
    const bounds = await page.locator('#desktop-stage').boundingBox();
    const x = Math.round(bounds.x + bounds.width * 0.4), y = Math.round(bounds.y + bounds.height * 0.55);
    const before = pointers.length;
    await swipe(client, x, y, { two: true, dx: 0, dy: -100 });
    const viewport = frame.locator('#viewport');
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(60);
    expect(pointers.length).toBe(before);
    const top = await viewport.evaluate(element => element.scrollTop);
    await frame.locator('#pointer-scroll').click();
    await expect(frame.locator('#pointer-scroll')).toHaveText('滚动程序');
    await swipe(client, x, y, { two: true, dx: 0, dy: -100 });
    await expect.poll(() => pointers.some(value => value.buttons === 16)).toBe(true);
    expect(pointers.some(value => value.buttons === 1 || value.buttons === 4)).toBe(false);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(top);
    const count = pointers.length;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(pointers.length).toBe(count);
  } finally { await client.detach(); await app.close(); }
});

test('a held trackpad drag defers direct promotion until release and cannot veto its own idle handoff', async ({ page }) => {
  test.setTimeout(60000);
  let offers = 0;
  await page.clock.install();
  await page.route('**/api/desktop/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
  const { app, frame, pointers } = await setup(page, { webrtc: true, rfbSize: { width: 640, height: 480 }, viewport: false });
  try {
    await trackpad(page);
    await frame.locator('#pointer-drag').click();
    await expect(frame.locator('#pointer-drag')).toHaveAttribute('aria-pressed', 'true');
    await page.clock.fastForward(16000);
    expect(offers).toBe(1); expect(app.vncConnections).toBe(1);
    await frame.locator('#pointer-drag').click();
    await expect(frame.locator('#pointer-drag')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => pointers.at(-1)?.buttons).toBe(0);
    await page.clock.fastForward(6000);
    await expect.poll(() => app.vncConnections, { timeout: 15000 }).toBe(2);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(offers).toBe(2);
    expect(pointers.filter(value => value.buttons === 1)).toHaveLength(1);
    expect(app.inputCalls).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
