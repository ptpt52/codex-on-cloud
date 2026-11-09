import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { acquireTerminalLease } from '../native/terminal-lease.mjs';

test('an empty legacy PID and free kernel lease never authorize taking over a live private tmux listener',async t=>{
 const root=await mkdtemp(join(tmpdir(),'terminal-lock-refusal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'tmux.sock'),server=net.createServer(socket=>socket.end());server.listen(path);await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const before=await lstat(path);await writeFile(join(root,'terminal.pid'),'');await writeFile(join(root,'terminal.lock'),'');
 for(let n=0;n<2;n++)await assert.rejects(promisify(execFile)(process.execPath,['native/terminal-host.mjs'],{env:{...process.env,DEPLOY_MODE:'terminal',RUNTIME_DIR:root,WORKSPACE_DIR:join(root,'workspace')},timeout:5000,maxBuffer:2048}),error=>error.code===1&&/已有私有 tmux 服务，不会接管/.test(error.stderr));
 assert.equal((await lstat(path)).ino,before.ino);assert.equal(await readFile(join(root,'terminal.pid'),'utf8'),'');assert.equal(server.listening,true);
});

test('Node owns the kernel lease until release or SIGKILL, with no persistent helper process',async t=>{
 const root=await mkdtemp(join(tmpdir(),'terminal-kernel-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'terminal.lock');await writeFile(path,'');
 const module=new URL('../native/terminal-lease.mjs',import.meta.url).href,child=spawn(process.execPath,['--input-type=module','-e',`import{acquireTerminalLease}from${JSON.stringify(module)};const lease=await acquireTerminalLease(process.argv[1]);console.log('held');setInterval(()=>{},1000);`,path],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');assert.equal((await readFile('/proc/'+child.pid+'/task/'+child.pid+'/children','utf8')).trim(),'');
 await assert.rejects(acquireTerminalLease(path),{status:409});
 const done=once(child,'close');child.kill('SIGKILL');await done;
 const lease=await acquireTerminalLease(path);try{lease.check();assert.equal((await lstat(path)).size,0);}finally{await lease.release();}
 const next=await acquireTerminalLease(path);await next.release();
});
