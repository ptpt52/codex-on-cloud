import http from 'node:http';
import { createFileWire, sendFileChunks, FILE_MAX, FILE_DOWNLOAD_MAX, FILE_DOWNLOAD_TIMEOUT, fileTimeoutCode } from './public/file-wire.js';
import { uploadOptions, uploadHeaders, uploadResult, validTransferName, validFileVersion, fileDownloadPath, recoverableFileStatus } from './public/file-upload.js';
import { normalizeEntryBasePath } from './entry-path.mjs';
import { FORWARD_FILES, ARTIFACT_LIMITS } from '../native/forward-artifacts.mjs';
import { validTransferWindow } from './public/transfer-window.js';
const fault=(status,message)=>Object.assign(Error(message),{status});
const rejectedStatuses=[400,404,409,410,412,413,429,507];
const responseError=(status,result,message)=>Object.assign(fault(status,result?.error||message),{
 outcome:['rejected','unknown'].includes(result?.outcome)?result.outcome:rejectedStatuses.includes(status)?'rejected':'unknown',fileCode:result?.fileCode,
});
// Fixed authenticated APIs on loopback only: shared files keep their four-stream
// and guest-upload quotas; published helpers keep the two-download limit.
export function attachServiceFiles(channel,{valid,headers,port,signal,fail,entryBasePath='/'}){
 const prefix=normalizeEntryBasePath(entryBasePath).slice(0,-1);
 let active,lastId=0,ended=false,recoverable=false,retireTimer;
 const subscriptions=[];
 const adapter={get readyState(){return channel.readyState;},get bufferedAmount(){return channel.bufferedAmount;},send:bytes=>channel.send(bytes),close:()=>channel.close(),
  addEventListener(type,fn){if(type==='message')subscriptions.push(channel.onMessage.subscribe(data=>fn({data})));else if(type==='close')subscriptions.push(channel.stateChange.subscribe(state=>{if(state==='closed')fn();}));else if(type==='error')subscriptions.push(channel.error.subscribe(fn));}};
 const wire=createFileWire(adapter,{control,chunk:receive,timedOut(err){if(active)reject(active,Object.assign(err,{status:408}));else wire.close(err);},failed(){ended=true;clearTimeout(retireTimer);signal.removeEventListener('abort',cancel);for(const subscription of subscriptions.splice(0))subscription?.unSubscribe?.();cleanup();fail(recoverable);}});
 function cleanup(){const entry=active;active=undefined;if(!entry)return;clearTimeout(entry.timer);entry.controller.abort();entry.req?.destroy();entry.res?.destroy();}
 function check(entry){if(!entry||entry!==active||!valid()||signal.aborted||ended)throw fault(401,'文件授权或连接已失效');}
 function finish(entry,value){
  if(active!==entry)return;
  try{check(entry);wire.send({type:'done',id:entry.id,...value});}
  catch(err){
   // The upload may already be committed. A failed completion record must
   // settle as unknown, never clear our deadline and strand the client.
   reject(entry,Object.assign(fault(err.status||502,'文件完成确认失败，结果未知；请检查文件状态后手动重试'),{outcome:'unknown'}));return;
  }
  cleanup();
 }
 function reject(entry,err){
  if(active!==entry)return;
  const status=err.status||502;
  recoverable=valid()&&!signal.aborted&&recoverableFileStatus(status);
  wire.quiesce(err);
  const outcome=['rejected','unknown'].includes(err.outcome)?err.outcome:rejectedStatuses.includes(status)?'rejected':'unknown';
  let notified=false;
  try{wire.send({type:'error',id:entry.id,status,outcome,message:err.status?err.message:'文件传输中断，结果未知；请检查文件状态后手动重试',...(fileTimeoutCode(err.code)?{code:err.code}:{}),...(['file_busy','file_exists'].includes(err.fileCode)?{fileCode:err.fileCode}:{}),...(recoverable?{recoverable:true}:{})});notified=true;}catch{}
  // A failed error record cannot participate in the graceful error handshake.
  // Closing immediately lets the browser settle unknown and release its slot.
  if(!notified){wire.close(err);return;}
  cleanup();if(recoverable)retireTimer=setTimeout(()=>wire.close(),3000).unref();
 }
 async function control(value){
  // A ready frame may already have released upload chunks when HTTP rejects
  // the request. Drain that ordered tail during the fixed retirement window;
  // closing immediately could discard the rejection before the browser sees it.
  if(recoverable)return;
  if(value.type==='cancel'){
   if(Object.keys(value).sort().join(',')!=='id,type'||!Number.isInteger(value.id)||value.id<=0||value.id!==lastId||active&&active.id!==value.id)throw fault(400,'文件取消参数无效');
   recoverable=true;wire.quiesce();cleanup();wire.send({type:'cancelled',id:value.id});retireTimer=setTimeout(()=>wire.close(),1500).unref();return;
  }
  if(value.type==='start'){
   const fields=Object.keys(value).sort().join(','),hasUpload=Object.hasOwn(value,'upload'),hasHelper=Object.hasOwn(value,'helper');
   const hasWindow=Object.hasOwn(value,'window'),hasVersion=Object.hasOwn(value,'version');
   const expected=['direction','id','name','size','type'];
   for(const field of ['helper','upload','window','version'])if(Object.hasOwn(value,field))expected.push(field);
   if(active||fields!==expected.sort().join(',')||hasUpload&&value.direction!=='upload'||hasVersion&&(value.direction!=='download'||hasHelper||!validFileVersion(value.version))||!Number.isInteger(value.id)||value.id<=lastId||value.id>2147483647||!validTransferName(value.name,value.direction==='upload')||!['upload','download'].includes(value.direction)||!Number.isSafeInteger(value.size)||value.size<0||value.size>(value.direction==='download'?FILE_DOWNLOAD_MAX:FILE_MAX))throw fault(400,'文件传输参数无效');
   if(hasWindow&&!validTransferWindow(value.window))throw fault(400,'文件窗口协商无效');
   const window=value.window??4;wire.setWindow(window);
   let path=prefix+fileDownloadPath(value.name,value.version);
   if(hasHelper){
    const helper=value.helper;
    if(value.direction!=='download'||!helper||typeof helper!=='object'||Array.isArray(helper)||Object.keys(helper).some(key=>!['arch','generation'].includes(key))||typeof helper.arch!=='string'||!Object.hasOwn(FORWARD_FILES,helper.arch)||value.name!==FORWARD_FILES[helper.arch]||value.size<=0||value.size>ARTIFACT_LIMITS.file||Object.hasOwn(helper,'generation')&&(typeof helper.generation!=='string'||!/^[a-f0-9]{32}$/.test(helper.generation)))throw fault(400,'助手下载参数无效');
    path=prefix+'/api/forward/download/'+helper.arch+(Object.hasOwn(helper,'generation')?'?generation='+helper.generation:'');
   }
   const upload=value.direction==='upload'?uploadOptions(value.upload):undefined;
   if(!valid())throw fault(401,'文件授权已失效');lastId=value.id;
   const entry=active={id:value.id,direction:value.direction,size:value.size,helper:hasHelper,window:hasWindow?window:undefined,received:0,ended:false,controller:new AbortController()};
   const large=value.direction==='download'&&value.size>FILE_MAX;
   entry.timer=setTimeout(()=>reject(entry,fault(408,large?'大文件下载超过三十分钟':'文件传输超过五分钟')),large?FILE_DOWNLOAD_TIMEOUT:300000);entry.timer.unref();
   const requestSignal=AbortSignal.any([signal,entry.controller.signal]);
   const req=entry.req=http.request({host:'127.0.0.1',port:port(),method:value.direction==='upload'?'PUT':'GET',path,signal:requestSignal,
    headers:{...headers,...(value.direction==='upload'?{'content-type':'application/octet-stream','content-length':value.size,...uploadHeaders(upload)}:{})}},res=>{
    entry.res=res;res.once('error',err=>reject(entry,err));
    if(value.direction==='download'){void download(entry,res).catch(err=>reject(entry,err));return;}
    const chunks=[];let total=0;res.on('data',bytes=>{total+=bytes.length;if(total>4096)res.destroy(fault(502,'文件响应过大'));else chunks.push(bytes);});
    res.once('end',()=>{
     if(active!==entry)return;
     try{check(entry);const result=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)throw responseError(res.statusCode,result,'上传失败');entry.result={name:uploadResult(result).name};entry.response=true;if(entry.ended)finish(entry,entry.result);}catch(err){reject(entry,err);}
    });
   });
   req.once('error',err=>reject(entry,err));
   if(value.direction==='upload'){req.flushHeaders();wire.send({type:'ready',id:entry.id,size:value.size,...(entry.window===undefined?{}:{window:entry.window})});}
   else req.end();return;
  }
  const entry=active;check(entry);
  if(Object.keys(value).sort().join(',')!=='id,type'||value.id!==entry.id||value.type!=='end'||entry.direction!=='upload'||entry.ended||entry.received!==entry.size)throw fault(400,'文件结束标记或长度无效');
  entry.ended=true;entry.req.end();if(entry.response)finish(entry,entry.result);
 }
 async function receive(bytes){
  if(recoverable)return;
  const entry=active;
  try{check(entry);if(entry.direction!=='upload'||entry.ended||entry.received+bytes.length>entry.size)throw fault(400,'文件数据长度无效');entry.received+=bytes.length;await new Promise((resolve,reject)=>entry.req.write(bytes,err=>err?reject(err):resolve()));check(entry);}
  catch(err){
   if(recoverable)return;
   if(err.status===400||err.status===401||!valid()||signal.aborted)throw err;
   reject(entry,err);
  }
 }
 async function download(entry,res){
  check(entry);if(res.statusCode!==200){
   const chunks=[];let size=0;for await(const bytes of res){check(entry);size+=bytes.length;if(size>4096)throw fault(502,'文件响应过大');chunks.push(bytes);}
   let result;try{result=JSON.parse(Buffer.concat(chunks));}catch{}
   throw responseError(res.statusCode,result,entry.helper?(res.statusCode===410?'助手版本已更新，请刷新下载列表':res.statusCode===409?'助手入口已变化，请重新构建并下载':'助手下载失败，请刷新列表后手动重试'):'下载失败，文件可能已不存在');
  }
  const length=Number(res.headers['content-length']);if(!Number.isSafeInteger(length)||length<0||length>FILE_DOWNLOAD_MAX)throw fault(413,'超过 1 GiB 的文件请使用 HTTPS 下载');
  if(entry.helper&&(length!==entry.size||length>ARTIFACT_LIMITS.file))throw fault(409,'助手大小已变化，请刷新下载列表');
  if(length!==entry.size)throw fault(412,'文件大小已变化，请刷新列表后重试');
  wire.send({type:'ready',id:entry.id,size:length,...(entry.window===undefined?{}:{window:entry.window})});let total=0;
  async function* source(){for await(const bytes of res){check(entry);total+=bytes.length;if(total>length)throw fault(502,'下载长度无效');yield bytes;}}
  await sendFileChunks(source(),wire,()=>active===entry&&valid());check(entry);if(total!==length)throw fault(502,'下载长度不完整');finish(entry,{size:total});
 }
 function cancel(){wire.close();}
 signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
 return{close:cancel};
}
