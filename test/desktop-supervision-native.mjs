// Real desktop supervisor, isolated Xvfb/XFCE/xterm/tmux. Viewer spawn failure
// must never terminate the display or existing task. No real Codex is started.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, lstat, symlink, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import net from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'codex-supervision-')), exec = promisify(execFile);
const runtime = join(root, 'run'), bin = join(root, 'bin'), home = join(root, 'home');
let host, output = '';
const alive = () => host && host.exitCode === null && host.signalCode === null;
async function until(probe, message) {
  for (let n = 0; n < 300; n++) { if (await probe()) return; if (!alive()) throw Error('isolated desktop exited: ' + output.slice(-4096)); await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(message + '\n' + output.slice(-4096));
}
const tmux = args => exec('tmux', ['-S', join(runtime, 'tmux.sock'), ...args], { timeout: 2000, maxBuffer: 4096 });
try {
  for (const path of [bin, home, join(root, 'panel/public')]) await mkdir(path, {recursive:true,mode:0o700});
  for (const folder of ['native', 'desktop']) await cp(resolve(folder), join(root, folder), {recursive:true,filter:path=>!path.includes('__pycache__')});
  await cp(resolve('panel/public/terminal-slots.js'), join(root, 'panel/public/terminal-slots.js'));
  // A broken interpreter on PATH can fall through to the installed binary.
  // Use a bounded isolated PATH with real dependencies and no x11vnc at all.
  for(const command of ['Xvfb','xauth','xdpyinfo','xdotool','xrandr','xprop','dbus-run-session','dbus-daemon','bash','sh','xfwm4','xfsettingsd','xfconf-query','xfdesktop','xfce4-panel','xterm','tmux','python3','dirname','head','sleep','env','stty','tput','readlink','sed']){
    let executable;
    for(const directory of process.env.PATH.split(':')){const path=join(directory,command);if(await access(path,constants.X_OK).then(()=>true,()=>false)){executable=path;break;}}
    assert.ok(executable,'missing test dependency '+command);await symlink(executable,join(bin,command));
  }
  let display;
  for (let number=199;number>=190;number--) {
    const used=await Promise.all([`/tmp/.X${number}-lock`,`/tmp/.X11-unix/X${number}`].map(path=>lstat(path).then(()=>true,()=>false)));
    if(!used.some(Boolean)){display=number;break;}
  }
  assert.ok(display,'need an unused isolated test display');
  const env={...process.env,HOME:home,PATH:bin,RUNTIME_DIR:runtime,WORKSPACE_DIR:join(root,'workspace'),DEPLOY_MODE:'desktop',DISPLAY_NUMBER:String(display),DESKTOP_SIZE:'800x800',MAX_TERMINALS:'4'};
  for(const key of ['TMUX','TMUX_PANE','BASH_ENV','ENV','DBUS_SESSION_BUS_ADDRESS','SESSION_MANAGER'])delete env[key];
  host=spawn(process.execPath,[join(root,'native/desktop.mjs')],{env,detached:true,stdio:['ignore','pipe','pipe']});
  host.on('error',error=>{output+=(error.code||'spawn failed');});
  for(const stream of [host.stdout,host.stderr])stream.on('data',bytes=>{output=(output+bytes.toString()).slice(-32768);});
  await until(()=>lstat(join(runtime,'vnc.sock')).then(s=>s.isSocket(),()=>false),'private VNC socket missing');
  let task;
  await until(async()=>{try{task=(await tmux(['display-message','-p','-t','=codex:0.0','#{pane_pid}'])).stdout.trim();return /^\d+$/.test(task);}catch{return false;}},'private task did not start');
  const original=await readFile('/proc/'+task+'/stat','utf8');
  for(let attempt=1;attempt<=2;attempt++){
    const viewer=net.createConnection(join(runtime,'vnc.sock'));viewer.on('error',()=>{});await once(viewer,'connect');viewer.destroy();
    await until(()=>output.split('无法启动 x11vnc').length-1>=attempt,'viewer failure was not observed');
    await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(alive(),true,'a failed viewer must not stop the desktop');
    assert.equal((await tmux(['display-message','-p','-t','=codex:0.0','#{pane_pid}'])).stdout.trim(),task);
    const current=await readFile('/proc/'+task+'/stat','utf8');assert.equal(current.slice(current.lastIndexOf(')')+2).split(' ')[19],original.slice(original.lastIndexOf(')')+2).split(' ')[19]);
    assert.equal((await exec('xdotool',['getdisplaygeometry'],{env:{...env,DISPLAY:':'+display,XAUTHORITY:join(runtime,'Xauthority')},timeout:2000,maxBuffer:1024})).stdout.trim(),'800 800');
  }
  console.log('PASS: repeated real viewer spawn errors preserve the desktop supervisor, isolated X display and original tmux shell. No Codex input or production service changes.');
} finally {
  if(alive()){
    const closed=once(host,'exit');host.kill('SIGTERM');const timer=setTimeout(()=>host.kill('SIGKILL'),4000);await closed;clearTimeout(timer);
  }
  await tmux(['kill-server']).catch(()=>{});await rm(root,{recursive:true,force:true});
}
