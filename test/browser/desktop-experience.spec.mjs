import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.locator('#password').fill(app.config.password);
  await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
}

test('focus layout preserves a tall desktop and one-step panel access across viewport sizes', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1600, height: 3200 } });
  let connections = 0;
  page.on('websocket', () => connections++);
  try {
    await login(page, app);
    await expect(page.locator('#workspace-tools')).toBeHidden();
    await expect(page.locator('#input-dock')).toBeHidden();
    for (const size of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', size.width >= 1200 ? 'sidebar' : 'top');
      // Resize, media-query control moves and visualViewport updates settle
      // asynchronously. Compare all rectangles from the same layout snapshot.
      await expect(async () => {
        const { stage, card, fits } = await page.evaluate(() => ({
          stage: document.getElementById('desktop-stage').getBoundingClientRect().toJSON(),
          card: document.getElementById('desktop-card').getBoundingClientRect().toJSON(),
          fits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
        }));
        // A short landscape viewport still reserves two accessible 44px rows.
        expect(stage.height).toBeGreaterThanOrEqual(size.height * (size.height < 540 ? 0.7 : 0.75));
        expect(stage.bottom).toBeLessThanOrEqual(card.bottom + 1);
        expect(fits).toBe(true);
      }).toPass({ timeout: 5000 });
      await page.locator('#toggle-controls-button').click();
      await expect(page.locator('#workspace-tools')).toBeVisible();
      await expect(page.locator('#workspace-tools')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#workspace-tools')).toBeHidden();
      await expect(page.locator('#toggle-controls-button')).toBeFocused();
      await page.locator('#toggle-input-button').click();
      await expect(page.locator('#input-dock')).toBeVisible();
      await page.locator('#mobile-input').fill('查看和关闭面板不发送这段草稿');
      await page.locator('#close-input-button').click();
    }
    await page.locator('#toggle-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('查看和关闭面板不发送这段草稿');
    await page.locator('#toggle-controls-button').click();
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#workspace-tools')).toBeVisible();
    expect(connections).toBe(1);
    expect(app.inputCalls).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
    expect(app.managementStats.viewportResizes).toBe(0);
  } finally { await app.close(); }
});

test('IME Escape keeps the input assistant and draft; ordinary Escape returns focus to its entry', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-input-button').click();
    const input = page.locator('#mobile-input');
    await input.fill('尚未发送的中文');
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
      await expect(page.locator('#input-dock')).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('尚未发送的中文');
    }
    await input.dispatchEvent('compositionstart');
    await page.keyboard.press('Escape');
    await expect(page.locator('#input-dock')).toBeVisible();
    await expect(input).toBeFocused();
    await input.dispatchEvent('compositionend');
    await page.keyboard.press('Escape');
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#toggle-input-button')).toBeFocused();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('keyboard panel dismissals keep focus on browser controls', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    const input = page.locator('#toggle-input-button'), tools = page.locator('#toggle-controls-button');
    await input.click();
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    await page.locator('#close-input-button').press('Space');
    await expect(input).toBeFocused();
    await tools.press('Enter');
    await page.locator('#close-controls-button').press('Enter');
    await expect(tools).toBeFocused();
    await tools.press('Enter');
    await expect(page.locator('#workspace-tools')).toBeVisible();
    await tools.press('Enter');
    await expect(page.locator('#workspace-tools')).toBeHidden();
    await expect(tools).toBeFocused();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('tool dialogs retain confirmation and return focus without losing the input draft', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-input-button').click();
    await page.locator('#mobile-input').fill('工具操作后继续编辑');
    await page.locator('#toggle-controls-button').click();
    await page.locator('#reconnect-button').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#reconnect-button')).toBeFocused();
    await expect(page.locator('#workspace-tools')).toBeVisible();
    await page.locator('#close-controls-button').click();
    await page.locator('#toggle-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('工具操作后继续编辑');
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('fullscreen tools name the exit action and reflect native fullscreen changes', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-controls-button').click();
    await page.getByRole('button', { name: '全屏', exact: true }).and(page.locator('#tools-fullscreen-button')).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.locator('#toggle-controls-button').click();
    await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '退出全屏');
    await page.locator('#workspace-tools').getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBeUndefined();
    await page.locator('#toggle-controls-button').click();
    await page.locator('#tools-fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-label', '全屏桌面');
    await expect(page.locator('#tools-fullscreen-button')).toHaveText('全屏');
    expect(app.vncConnections).toBe(1);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('logging out from the fullscreen sidebar leaves an interactive login', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.locator('#fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.locator('#logout-button').click();
    await page.locator('#accept-confirmation').click();
    await expect(page.locator('#login-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await page.locator('#password').click();
    await expect(page.locator('#password')).toBeFocused();
    expect(app.managementStats.restarts).toBe(0);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop settings open and close without leaving fullscreen', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-controls-button').click();
    await page.locator('#tools-fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.locator('#toggle-controls-button').click();
    const settings = page.locator('#desktop-settings-button');
    await settings.click();
    await expect(page.locator('#desktop-settings-dialog')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.locator('#close-desktop-settings').click();
    await expect(settings).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    expect(app.vncConnections).toBe(1);
    expect(app.managementStats.restarts).toBe(0);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop feedback stays above tools in both layouts and returns to the page on fullscreen exit', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app);
    const toast = page.locator('#toast');
    const expectPainted = async () => {
      await expect(toast).toContainText('拖动模式');
      await expect(toast).toHaveCSS('pointer-events', 'none');
      await expect.poll(() => toast.evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        element.style.pointerEvents = 'auto';
        try { return element.contains(document.elementFromPoint(x + width / 2, y + height / 2)); }
        finally { element.style.removeProperty('pointer-events'); }
      })).toBe(true);
    };
    await page.locator('#toggle-controls-button').click();
    await page.locator('#pan-button').click();
    await expectPainted();
    await page.locator('#pan-button').click();
    await page.locator('#tools-fullscreen-button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
    await page.locator('#toggle-controls-button').click();
    await page.locator('#pan-button').click();
    await expectPainted();
    await page.locator('#tools-fullscreen-button').click();
    await expect.poll(() => toast.evaluate(element => element.parentElement === document.body)).toBe(true);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop feedback remains visible when a keyboard or zoom reduces the visible area', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
  });
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-controls-button').click();
    await page.evaluate(() => {
      Object.assign(visualViewport, { width: 254, height: 390, offsetLeft: 80, offsetTop: 40 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.locator('#pan-button').click();
    const toast = page.locator('#toast');
    await expect(toast).toContainText('拖动模式');
    await expect(toast).toHaveCSS('pointer-events', 'none');
    await expect.poll(async () => {
      const box = await toast.boundingBox();
      return !!box && box.x >= 80 && box.x + box.width <= 334 && box.y >= 40 && box.y + box.height <= 430;
    }).toBe(true);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop pan pauses assistant writes immediately while keeping the draft editable', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-controls-button').click();
    await page.locator('#pan-button').click();
    await page.locator('#toggle-input-button').click();
    const draft = page.locator('#mobile-input');
    await draft.fill('拖动画面时保留的草稿');
    await expect(page.locator('#pan-input-note')).toBeVisible();
    await expect(page.locator('#paste-button')).toBeDisabled();
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    expect(app.inputCalls).toEqual([]);
    await page.locator('#toggle-controls-button').click();
    await page.locator('#pan-button').click();
    await page.locator('#toggle-input-button').click();
    await expect(draft).toHaveValue('拖动画面时保留的草稿');
    await expect(page.locator('#pan-input-note')).toBeHidden();
    await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toHaveLength(1);
    expect(app.inputCalls[0].action).toBe('paste');
  } finally { await app.close(); }
});

test('pan mode keeps an exit on the unobstructed desktop and resumes without sending input', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 1600, height: 2600 } });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app);
    const exit = page.locator('#end-pan-button');
    const panLayer = page.frameLocator('#desktop-frame').locator('#pan-layer');
    await expect(exit).toBeHidden();
    await page.locator('#toggle-controls-button').click();
    await page.locator('#pan-button').click();
    await expect(exit).toBeHidden();
    await page.locator('#close-controls-button').click();
    await expect(panLayer).toBeVisible();
    await expect(exit).toBeVisible();
    await exit.click();
    await expect(panLayer).toBeHidden();
    await expect(exit).toBeHidden();
    expect(app.inputCalls).toEqual([]);
    expect(app.vncConnections).toBe(1);
  } finally { await app.close(); }
});

test('partial saved terminal preferences preserve display choices without opening an unspecified tool panel', async ({ page }) => {
  const app = await fixture({ rfb: true });
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
    layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalFontSize: 18, terminalInputCollapsed: true,
  })));
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#workspace-tools')).toBeHidden();
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#terminal-font-label')).toHaveText('18');
    await expect(page.frameLocator('#desktop-frame').locator('#terminal')).toBeVisible();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
