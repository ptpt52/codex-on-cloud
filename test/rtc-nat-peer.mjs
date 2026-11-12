import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { chromium } from '@playwright/test';
import { createRTCBridge } from '../panel/rtc.mjs';
import { createForwardPeer } from '../panel/forward-rtc.mjs';
import { rtcOffer, rtcAddress } from '../panel/rtc-network.mjs';

const [role, mode] = process.argv.slice(2), emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin }), token = 't'.repeat(43);
const reflexiveOnly = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || / typ srflx(?: |$)/.test(line)).join('\r\n');
let peer, browser, ended = false;
let stage = 'startup';
const phase = value => { stage = value; emit({ type: 'stage', stage }); };
const timeout = setTimeout(() => { emit({ type: 'error', message: `NAT peer timeout (${role}: ${stage})` }); process.exitCode = 1; input.close(); void peer?.destroy(); void browser?.close(); }, 30000);
async function close() { if (ended) return; ended = true; clearTimeout(timeout); await peer?.destroy(); await browser?.close(); input.close(); }
input.on('close', () => { void close(); });
try {
  if (role === 'answer') {
    phase('waiting-for-offer');
    input.on('line', line => { void (async () => {
      assert.ok(Buffer.byteLength(line) <= 49152); const record = JSON.parse(line);
      if (!['offer', 'rtc_offer'].includes(record.type)) return;
      phase('answering');
      const address = rtcAddress(); assert.equal(address, process.env.NAT_TEST_SERVER_ADDRESS);
      const options = { address, stunUrl: 'stun:13.0.0.1:3478', valid: () => !ended, closed() {} };
      peer = mode === 'go' ? createForwardPeer({ ...options, id: record.id, authenticate: value => value === token,
        status: value => emit({ type: 'rtc_status', ...value }), connect: socket => socket.on('message', (bytes, binary) => { assert.equal(binary, true); socket.send(bytes); }) })
        : createRTCBridge({ ...options, serviceOnly: true, connectFiles: channel => {
          channel.onMessage.subscribe(bytes => channel.send(bytes)); return { close() { channel.close(); } };
        } });
      const answer = await peer.answer(rtcOffer({ type: 'offer', sdp: reflexiveOnly(record.sdp) }));
      const sdp = reflexiveOnly(typeof answer === 'string' ? answer : answer.sdp);
      assert.match(sdp, /11\.0\.0\.2 45000 typ srflx/);
      emit({ type: mode === 'go' ? 'rtc_answer' : 'answer', id: record.id, sdp });
      phase('waiting-for-data');
    })().catch(error => { emit({ type: 'error', message: error.message }); void close(); }); });
    emit({ type: 'ready' });
  } else {
    phase('launching-browser');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, timeout: 15000, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    phase('creating-page');
    const page = await browser.newPage();
    page.on('pageerror', error => emit({ type: 'error', message: error.message }));
    await page.exposeFunction('natSignal', value => value.type === 'stage' ? phase(value.stage) : emit(value));
    input.on('line', line => { const value = JSON.parse(line); if (value.type === 'answer') void page.evaluate(sdp => window.natPeer.setRemoteDescription({ type: 'answer', sdp }), value.sdp).catch(error => emit({ type: 'error', message: error.message })); });
    const result = await page.evaluate(async blocked => {
      await window.natSignal({ type: 'stage', stage: 'creating-offer' });
      const pc = window.natPeer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:13.0.0.1:3478' }] });
      const channel = pc.createDataChannel('codex-files', { protocol: 'files-v1', ordered: true }); channel.binaryType = 'arraybuffer';
      let total = 0;
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          if (blocked) return resolve({ blocked: true, bytes: 0 });
          const stats = [...(await pc.getStats()).values()].filter(row => ['candidate-pair', 'local-candidate', 'remote-candidate'].includes(row.type));
          reject(Error(`NAT channel timeout: ICE ${pc.iceConnectionState}; ${JSON.stringify(stats)}`));
        }, blocked ? 5000 : 15000);
        channel.onopen = () => { if (blocked) { clearTimeout(timer); reject(Error('Blocked UDP unexpectedly connected')); } else channel.send(new Uint8Array(4096).fill(37)); };
        channel.onmessage = event => {
          const bytes = new Uint8Array(event.data); if (bytes.length !== 4096 || !bytes.every(value => value === 37)) { clearTimeout(timer); reject(Error('Corrupted NAT data')); return; }
          total += bytes.length;
          if (total === 262144) { clearTimeout(timer); resolve({ bytes: total }); } else channel.send(bytes);
        };
      });
      await pc.setLocalDescription(await pc.createOffer());
      await window.natSignal({ type: 'stage', stage: 'gathering-candidates' });
      await new Promise(resolve => { if (pc.iceGatheringState === 'complete') resolve(); else { const timer = setTimeout(resolve, 2000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }; } });
      if (!pc.localDescription.sdp.includes('12.0.0.2 45100 typ srflx')) throw Error('Browser STUN mapping missing');
      await window.natSignal({ type: 'offer', sdp: pc.localDescription.sdp });
      await window.natSignal({ type: 'stage', stage: 'waiting-for-data' });
      const result = await done;
      if (!blocked) {
        const rows = [...(await pc.getStats()).values()], pair = rows.find(row => row.type === 'candidate-pair' && row.nominated && row.state === 'succeeded');
        const remote = rows.find(row => row.id === pair?.remoteCandidateId);
        if (!['srflx', 'prflx'].includes(remote?.candidateType) || remote.address !== '11.0.0.2' || remote.port !== 45000) throw Error('Transfer bypassed the NAT candidate');
      }
      pc.close(); return result;
    }, mode === 'blocked');
    emit({ type: 'done', ...result }); await close();
  }
} catch (error) { emit({ type: 'error', message: error.message }); process.exitCode = 1; await close(); }
