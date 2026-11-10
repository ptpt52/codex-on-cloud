// Actual coturn + UDP/TCP/TLS allocations + forced relay DTLS/SCTP. No system services.
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RTCPeerConnection } from 'werift';
import { createRTCBridge, rtcOffer } from '../panel/rtc.mjs';
import { turnCredentials } from '../selfhost/turn.mjs';

const directory = await mkdtemp(join(tmpdir(), 'codex-turn-native-'));
const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; };
const until = async (probe, label, duration = 15000) => { const end = Date.now() + duration; while (Date.now() < end) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(label); };
let child, log = '', bridge, client;
const deadline = setTimeout(() => { console.error('TURN test deadline'); process.exitCode = 1; child?.kill('SIGKILL'); }, 90000);
try {
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem'), port = await freePort(), tlsPort = await freePort();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const secret = 'synthetic-turn-secret-'.repeat(3), relay = { addresses: ['127.0.0.1'], minPort: 49160, maxPort: 49223 };
  child = spawn(process.env.TURNSERVER_PATH || 'turnserver', ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', '--listening-port=' + port, '--tls-listening-port=' + tlsPort,
    '--min-port=49160', '--max-port=49223', '--realm=localhost', '--use-auth-secret', '--static-auth-secret=' + secret, '--cert=' + cert, '--pkey=' + key,
    '--userdb=' + join(directory, 'turn.db'), '--no-cli', '--no-dtls', '--no-multicast-peers', '--allow-loopback-peers', '--relay-threads=1', '--total-quota=16', '--user-quota=8', '--pidfile=' + join(directory, 'turn.pid'), '--log-file=stdout', '--simple-log'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { log = error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-65536); });
  await until(() => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.on('error', () => resolve(false)); s.on('connect', () => { s.destroy(); resolve(true); }); }), 'coturn did not listen');
  const auth = turnCredentials({ secret, slug: 'relay-test', realm: 'localhost', relay }).iceServers[1], ca = await readFile(cert);
  for (const transport of ['udp', 'tcp', 'tls']) {
    const url = `${transport === 'tls' ? 'turns' : 'turn'}:127.0.0.1:${transport === 'tls' ? tlsPort : port}?transport=${transport === 'udp' ? 'udp' : 'tcp'}`;
    const iceServers = [{ urls: [url], username: auth.username, credential: auth.credential }];
    client = new RTCPeerConnection({ iceServers, iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false, iceTransportPolicy: 'relay', iceInterfaceAddresses: { udp4: '127.0.0.1' }, turnTlsOptions: { ca, rejectUnauthorized: true } });
    const channel = client.createDataChannel('codex-files', { protocol: 'files-v1', ordered: true }); let echoed = '';
    channel.onMessage.subscribe(data => { echoed = data.toString(); });
    bridge = createRTCBridge({ address: '127.0.0.1', iceServers, relay, turnCa: ca, serviceOnly: true, valid: () => true, closed: () => {},
      connectFiles: value => { value.onMessage.subscribe(data => value.send(data)); return { close() {} }; } });
    await client.setLocalDescription(await client.createOffer());
    assert(client.localDescription.sdp.includes('typ relay'), transport + ' allocation missing');
    assert(!client.localDescription.sdp.includes('typ host'), 'forced relay exposed a host');
    await client.setRemoteDescription(await bridge.answer(rtcOffer(client.localDescription, { relay })));
    await until(() => channel.readyState === 'open', transport + ' relay DTLS/SCTP did not open');
    assert.equal(client.iceTransports[0].connection.nominated.localCandidate.type, 'relay');
    channel.send('forced-relay-' + transport);
    await until(() => echoed === 'forced-relay-' + transport, transport + ' relay payload missing');
    await bridge.destroy(); bridge = undefined; await client.close(); client = undefined;
    console.log('✓ actual coturn forced relay data over ' + transport.toUpperCase());
  }
} catch (error) { console.error(log.slice(-4000)); throw error; }
finally { clearTimeout(deadline); await bridge?.destroy(); await client?.close(); if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true }); }
