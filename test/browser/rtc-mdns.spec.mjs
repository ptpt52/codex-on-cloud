import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import multicastDNS from 'multicast-dns';
import { privateIPv4 } from '../../panel/rtc-network.mjs';
import { fixture } from '../fixture.mjs';

// In this isolated test browser, expose candidates only so the fixture can
// replace them with its own masked names and deterministic multicast replies.
test.use({ launchOptions: { ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });

test('masked Chrome candidates resolve past unrelated records and establish real UDP/DTLS from server-initiated checks', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true });
  const responder = multicastDNS({ interface: '127.0.0.1', bind: '0.0.0.0' }), names = new Map();
  let queries = 0, websockets = 0;
  page.on('websocket', () => websockets++);
  try {
    await once(responder, 'ready', { signal: AbortSignal.timeout(2000) });
    responder.on('query', packet => {
      const matching = packet.questions.filter(question => names.has(question.name));
      if (!matching.length) return;
      queries++;
      responder.respond([{ name: 'unrelated.local', type: 'AAAA', data: 'fd00::1', ttl: 120 },
        ...matching.map(question => ({ name: question.name, type: 'A', data: names.get(question.name), ttl: 120 }))]);
    });
    await page.route('**/api/desktop/rtc', async route => {
      const body = route.request().postDataJSON();
      body.sdp = body.sdp.split(/\r?\n/).flatMap(line => {
        if (!line.startsWith('a=candidate:')) return [line];
        const parts = line.split(' ');
        if (parts[2].toLowerCase() !== 'udp' || !privateIPv4(parts[4])) return [];
        const name = `test-${randomUUID()}.local`; names.set(name, parts[4]); parts[4] = name;
        return [parts.join(' ')];
      }).join('\r\n');
      expect(names.size).toBeGreaterThan(0);
      const response = await route.fetch({ postData: JSON.stringify(body) }), answer = await response.json();
      // Chrome cannot initiate a successful check at this unbound address.
      // Only the server's successfully resolved mDNS candidate can reach it.
      answer.sdp = answer.sdp.split(/\r?\n/).map(line => {
        if (!line.startsWith('a=candidate:')) return line;
        const parts = line.split(' '); parts[4] = '127.0.0.2'; return parts.join(' ');
      }).join('\r\n');
      await route.fulfill({ response, json: answer });
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密直连');
    expect(queries).toBeGreaterThan(0); expect(websockets).toBe(0); expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally {
    await app.close(); await new Promise(resolve => responder.destroy(resolve));
  }
});
