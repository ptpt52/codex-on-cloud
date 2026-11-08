import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { mkdtemp, mkdir, chmod, stat, readFile, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { listenPrivateHTTP } from '../native/private-http.mjs';
import { loginClient } from '../panel/login-client.mjs';

async function ingress(t) {
  const app = await fixture(); t.after(() => app.close());
  const path = join(app.directory, 'tunnel.sock'); await app.panel.startTunnel(path);
  const request = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path, path: url, method: body === undefined ? 'GET' : 'POST',
      headers: { host: new URL(app.config.origin).host, origin: app.config.origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, path, request };
}

test('only the private Tunnel ingress separates edge client login limits; TCP spoofing cannot evade them', async t => {
  const { app, path, request } = await ingress(t);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (let n = 0; n < 10; n++) assert.equal((await request('/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await request('/api/login', { username: 'admin', password: app.config.password })).status, 429);
  assert.equal((await request('/api/login', { username: 'admin', password: app.config.password }, { 'cf-connecting-ipv6': '2001:db8::97' })).status, 429);
  const other = await request('/api/login', { username: 'admin', password: app.config.password }, { 'cf-connecting-ip': '192.0.2.2' });
  assert.equal(other.status, 200);
  for (let n = 0; n < 10; n++) assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' }, headers: { 'cf-connecting-ip': '198.51.100.' + (n + 1), 'x-forwarded-for': '198.51.100.' + (n + 1) } })).status, 401);
  assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: app.config.password }, headers: { 'cf-connecting-ip': '203.0.113.44' } })).status, 429);
  assert.equal((await request('/api/login', { username: 'admin', password: app.config.password }, { 'cf-connecting-ip': '192.0.2.3' })).status, 200);
  assert.deepEqual(app.inputCalls, []);
});

test('private HTTP and WebSocket ingress retain Host, Origin, authentication, CSRF and screen limits', async t => {
  const { app, path, request } = await ingress(t);
  assert.equal((await request('/healthz', undefined, {host:'attacker.test'})).status, 400);
  assert.equal((await request('/api/login', {}, {origin:'https://attacker.test'})).status, 403);
  assert.equal((await request('/api/state')).status, 401);
  await app.login(); await app.claim();
  assert.equal((await request('/api/key', {key:'Enter'}, {cookie:app.cookie,'x-viewer-id':app.viewer})).status, 403);
  assert.equal((await app.request('/api/security/screen-lock', {method:'POST',body:{enabled:true,password:'synthetic-screen-password'}})).status, 200);
  const body = { viewer: app.viewer, lockPassword: 'wrong' }, headers = {cookie:app.cookie,'x-csrf-token':app.csrf,'x-viewer-id':app.viewer};
  for (let n=0;n<20;n++) assert.equal((await request('/api/desktop/claim', body, headers)).status, 403);
  body.lockPassword='synthetic-screen-password';
  assert.equal((await request('/api/desktop/claim', body, headers)).status, 429);
  assert.equal((await request('/api/desktop/claim', body, {...headers,'cf-connecting-ip':'192.0.2.2'})).status, 200);
  const url = `ws+unix://${path}:/desktop/websockify?viewer=${app.viewer}`;
  const ws = new WebSocket(url, { headers: {host:new URL(app.config.origin).host,origin:app.config.origin,cookie:app.cookie} });
  ws.on('error',()=>{}); t.after(()=>ws.terminate()); await once(ws,'open');
  const result=once(ws,'message');ws.send('isolated tunnel fixture');assert.equal((await result)[0].toString(),'isolated tunnel fixture');
  for(const change of [{origin:'https://attacker.test'}, {cookie:''}, {host:'attacker.test'}]) {
    const denied = new WebSocket(url,{headers:{host:new URL(app.config.origin).host,origin:app.config.origin,cookie:app.cookie,...change}});denied.on('error',()=>{});
    const [,_res]=await once(denied,'unexpected-response');_res.resume();denied.terminate();assert.ok([401,403].includes(_res.statusCode));
  }
  assert.deepEqual(app.inputCalls, []);
});

test('trusted client keys canonicalize IPv6 and reject malformed or scoped edge headers with a bounded fallback', () => {
  const req={socket:{remoteAddress:'127.0.0.1'},headers:{'cf-connecting-ip':'2001:0db8:0:0:0:0:0:1'}};
  assert.equal(loginClient(req,true),'tunnel:2001:db8::1');assert.equal(loginClient(req,false),'socket:127.0.0.1');
  req.headers['cf-connecting-ip']='192.0.2.1';req.headers['cf-connecting-ipv6']='2001:db8::5';assert.equal(loginClient(req,true),'tunnel:192.0.2.1');
  req.headers['cf-connecting-ip']='240.16.0.1';assert.equal(loginClient(req,true),'tunnel:2001:db8::5');
  for(const value of [undefined, ['192.0.2.1'], '192.0.2.1, 192.0.2.2', 'fe80::1%eth0', 'x'.repeat(128)]) {req.headers['cf-connecting-ip']=value;assert.equal(loginClient(req,true),'tunnel:unknown');}
});

test('private ingress rejects public directories, occupied paths and live sockets, and recovers a crashed listener', async t => {
  const root=await mkdtemp(join(tmpdir(),'codex-private-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'tunnel.sock'), serve=()=>http.createServer((_req,res)=>res.end('ok'));
  await writeFile(path,'preserve');await assert.rejects(listenPrivateHTTP(serve(),path));assert.equal(await readFile(path,'utf8'),'preserve');await unlink(path);
  await symlink(join(root,'elsewhere'),path);await assert.rejects(listenPrivateHTTP(serve(),path));await unlink(path);
  await mkdir(join(root,'public'),{mode:0o755});await chmod(join(root,'public'),0o755);await assert.rejects(listenPrivateHTTP(serve(),join(root,'public','tunnel.sock')),/私有目录/);
  execFileSync('python3',['-c','import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])',path]);
  const stop=await listenPrivateHTTP(serve(),path);t.after(stop);assert.equal((await stat(path)).mode & 0o777,0o600);
  await assert.rejects(listenPrivateHTTP(serve(),path),/运行/);assert.equal((await stat(path)).isSocket(),true);
  await stop();await assert.rejects(stat(path),{code:'ENOENT'});
});
