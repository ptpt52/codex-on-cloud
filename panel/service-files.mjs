import http from 'node:http';
import { createFileWire, sendFileChunks, FILE_MAX } from './public/file-wire.js';
import { uploadOptions, uploadHeaders, uploadResult } from './public/file-upload.js';
const fault=(status,message)=>Object.assign(Error(message),{status});
function fileName(name){return typeof name==='string'&&!!name&&name!=='.'&&name!=='..'&&!name.startsWith('.upload-')&&!/[/\\\x00-\x1f\x7f]/.test(name)&&Buffer.byteLength(name)<=240;}
// This adapter can only address the existing authenticated file API on loopback.
// Its request participates in the same global four-stream and guest upload quota.
export function attachServiceFiles(channel,{valid,headers,port,signal,fail}){
 let active,lastId=0,ended=false,recoverable=false,retireTimer;
 const adapter={get readyState(){return channel.readyState;},get bufferedAmount(){return channel.bufferedAmount;},send:bytes=>channel.send(bytes),close:()=>channel.close(),
  addEventListener(type,fn){if(type==='message')channel.onMessage.subscribe(data=>fn({data}));else if(type==='close')channel.stateChange.subscribe(state=>{if(state==='closed')fn();});else if(type==='error')channel.error.subscribe(fn);}};
 const wire=createFileWire(adapter,{control,chunk:receive,failed(){ended=true;clearTimeout(retireTimer);cleanup();fail(recoverable);}});
 function cleanup(){const entry=active;active=undefined;if(!entry)return;clearTimeout(entry.timer);entry.controller.abort();entry.req?.destroy();entry.res?.destroy();}
 function check(entry){if(!entry||entry!==active||!valid()||signal.aborted||ended)throw fault(401,'文件授权或连接已失效');}
 function finish(entry,value){if(active!==entry)return;try{check(entry);wire.send({type:'done',id:entry.id,...value});}catch{}cleanup();}
 function reject(entry,err){if(active!==entry)return;recoverable=[404,409,412,413,429,507].includes(err.status);try{wire.send({type:'error',id:entry.id,status:err.status||502,message:err.status?err.message:'文件传输中断，结果未知；请检查文件状态后手动重试',...(recoverable?{recoverable:true}:{})});}catch{}cleanup();if(recoverable)retireTimer=setTimeout(()=>wire.close(),3000).unref();}
 async function control(value){
  if(recoverable)throw fault(409,'文件通道正在结束');
  if(value.type==='start'){
   const fields=Object.keys(value).sort().join(','),hasUpload=Object.hasOwn(value,'upload');
   if(active||fields!==(hasUpload?'direction,id,name,size,type,upload':'direction,id,name,size,type')||hasUpload&&value.direction!=='upload'||!Number.isInteger(value.id)||value.id<=lastId||value.id>2147483647||!fileName(value.name)||!['upload','download'].includes(value.direction)||!Number.isSafeInteger(value.size)||value.size<0||value.size>FILE_MAX)throw fault(400,'文件传输参数无效');
   const upload=value.direction==='upload'?uploadOptions(value.upload):undefined;
   if(!valid())throw fault(401,'文件授权已失效');lastId=value.id;
   const entry=active={id:value.id,direction:value.direction,size:value.size,received:0,ended:false,controller:new AbortController()};
   entry.timer=setTimeout(()=>reject(entry,fault(408,'文件传输超过五分钟')),300000);entry.timer.unref();
   const requestSignal=AbortSignal.any([signal,entry.controller.signal]);
   const req=entry.req=http.request({host:'127.0.0.1',port:port(),method:value.direction==='upload'?'PUT':'GET',path:'/api/files/'+encodeURIComponent(value.name),signal:requestSignal,
    headers:{...headers,...(value.direction==='upload'?{'content-type':'application/octet-stream','content-length':value.size,...uploadHeaders(upload)}:{})}},res=>{
    entry.res=res;
    if(value.direction==='download'){void download(entry,res).catch(err=>reject(entry,err));return;}
    const chunks=[];let total=0;res.on('data',bytes=>{total+=bytes.length;if(total>4096)res.destroy(fault(502,'文件响应过大'));else chunks.push(bytes);});
    res.once('error',err=>reject(entry,err));res.once('end',()=>{
     if(active!==entry)return;
     try{check(entry);const result=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)throw fault(res.statusCode,result.error||'上传失败');entry.result={name:uploadResult(result).name};entry.response=true;if(entry.ended)finish(entry,entry.result);}catch(err){reject(entry,err);}
    });
   });
   req.once('error',err=>reject(entry,err));
   if(value.direction==='upload'){req.flushHeaders();wire.send({type:'ready',id:entry.id,size:value.size});}
   else req.end();return;
  }
  const entry=active;check(entry);
  if(Object.keys(value).sort().join(',')!=='id,type'||value.id!==entry.id||value.type!=='end'||entry.direction!=='upload'||entry.ended||entry.received!==entry.size)throw fault(400,'文件结束标记或长度无效');
  entry.ended=true;entry.req.end();if(entry.response)finish(entry,entry.result);
 }
 async function receive(bytes){const entry=active;check(entry);if(entry.direction!=='upload'||entry.ended||entry.received+bytes.length>entry.size)throw fault(400,'文件数据长度无效');entry.received+=bytes.length;await new Promise((resolve,reject)=>entry.req.write(bytes,err=>err?reject(err):resolve()));check(entry);}
 async function download(entry,res){
  check(entry);if(res.statusCode!==200){res.resume();throw fault(res.statusCode,'下载失败，文件可能已不存在');}
  const length=Number(res.headers['content-length']);if(!Number.isSafeInteger(length)||length<0||length>FILE_MAX)throw fault(413,'此文件请使用 HTTPS 下载');
  wire.send({type:'ready',id:entry.id,size:length});let total=0;
  async function* source(){for await(const bytes of res){check(entry);total+=bytes.length;if(total>length)throw fault(502,'下载长度无效');yield bytes;}}
  await sendFileChunks(source(),wire,()=>active===entry&&valid());check(entry);if(total!==length)throw fault(502,'下载长度不完整');finish(entry,{size:total});
 }
 const cancel=()=>wire.close();signal.addEventListener('abort',cancel,{once:true});
 return{close(){signal.removeEventListener('abort',cancel);wire.close();cleanup();}};
}
