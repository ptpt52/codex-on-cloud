import { createFileWire, createFileBuffer, sendFileChunks, FILE_CHUNK, FILE_MAX } from './file-wire.js';
import { uploadOptions, uploadResult } from './file-upload.js';
import { FORWARD_CLIENTS } from './forward-platform.js';
import { validTransferWindow } from './transfer-window.js';
// Amortize File/provider access over one maximum window, independently of
// the negotiated send credits. Keep only one read in flight, at most 256 KiB.
const FILE_READ_BLOCK = 16 * FILE_CHUNK;
export function createFileClient(channel, failed = () => {}, { window = 4 } = {}) {
 if (!validTransferWindow(window)) throw Error('文件窗口能力无效');
 let active,id=0,recoverable=false,cancelingId=0,cancelTimer;
 const unknown=()=>Object.assign(Error('文件直连已断开，结果未知；请检查文件状态后手动重试'),{outcome:'unknown'});
 const settle=(err,result)=>{if(!active)return;const entry=active;active=null;clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);err?entry.reject(err):entry.resolve(result);};
 const wire=createFileWire(channel,{failed(err){clearTimeout(cancelTimer);settle(err);failed(recoverable);},chunk(bytes){
  if(cancelingId)return;
  if(!active||active.direction!=='download'||!active.started||active.received+bytes.length>active.size||active.received+bytes.length>FILE_MAX)throw unknown();
  active.received+=bytes.length;active.buffer.append(bytes);active.progressAt=performance.now();active.progress?.(active.received,active.size);
 },control(value){
  if(cancelingId){if(value.type==='cancelled'&&value.id===cancelingId)wire.close();return;}
  const entry=active;if(!entry||value.id!==entry.id)throw unknown();
  if(value.type==='error'){
   recoverable=value.recoverable===true&&[404,409,410,412,413,429,503,507].includes(value.status);
   const outcome=['rejected','unknown'].includes(value.outcome)?value.outcome:[404,409,410,412,413,429,507].includes(value.status)?'rejected':'unknown';
   settle(Object.assign(Error(typeof value.message==='string'?value.message:'文件传输失败'),{status:Number.isInteger(value.status)?value.status:502,outcome,...(['file_busy','file_exists'].includes(value.fileCode)?{fileCode:value.fileCode}:{})}));wire.close();return;
  }
  if(value.type==='ready'){
   if(entry.started||!Number.isSafeInteger(value.size)||value.size<0||value.size>FILE_MAX||(entry.direction==='upload'||entry.helper)&&value.size!==entry.size)throw unknown();
   const selected=value.window??4;
   if(!validTransferWindow(selected)||selected>window)throw unknown();
   wire.setWindow(selected);entry.started=true;entry.size=value.size;entry.progressAt=performance.now();
   if(entry.direction==='download'){entry.buffer=createFileBuffer(entry.size);entry.progress?.(0,entry.size);}
   if(entry.direction==='upload')void(async()=>{
    async function* source(){
     for(let offset=0;offset<entry.size;offset+=FILE_READ_BLOCK){
      if(active!==entry)throw unknown();
      const end=Math.min(entry.size,offset+FILE_READ_BLOCK),at=performance.now();
      const bytes=await entry.file.slice(offset,end).arrayBuffer();entry.readMs+=performance.now()-at;
      if(active!==entry||bytes.byteLength!==end-offset)throw unknown();
      yield new Uint8Array(bytes);
     }
    }
    entry.progress?.(0,entry.size);
    await sendFileChunks(source(),wire,()=>active===entry,bytes=>{if(active===entry){entry.received+=bytes;entry.progressAt=performance.now();entry.progress?.(entry.received,entry.size,{...wire.metrics,fileReadMs:Math.round(entry.readMs)});}});
    if(active===entry){entry.endSent=true;wire.send({type:'end',id:entry.id});}
   })().catch(err=>{if(active===entry){settle(err);wire.close();}});
   return;
  }
  if(value.type!=='done'||!entry.started||entry.direction==='upload'&&(!entry.endSent||entry.received!==entry.size)||entry.direction==='download'&&(entry.received!==entry.size||value.size!==entry.size))throw unknown();
  settle(null,entry.direction==='download'?entry.buffer.blob():uploadResult({ok:true,name:value.name}));
 }});
 function transfer(direction,name,size,file,upload,signal,helper,progress){
  if(signal?.aborted)return Promise.reject(signal.reason||unknown());
  if(!wire.ready||active||cancelingId||id>=2147483647||!Number.isSafeInteger(size)||size<0||size>FILE_MAX)return Promise.reject(Object.assign(Error('文件直连繁忙、未就绪或文件超过 50 MiB'),{outcome:'rejected'}));
  wire.resetMetrics();
  return new Promise((resolve,reject)=>{
   const abort=()=>{if(active!==entry)return;recoverable=true;cancelingId=entry.id;settle(signal?.reason||unknown());try{wire.send({type:'cancel',id:entry.id});cancelTimer=setTimeout(()=>wire.close(),1500);}catch{wire.close();}};
   const entry=active={id:++id,direction,size,file,helper:!!helper,received:0,readMs:0,started:false,endSent:false,signal,abort,progress,resolve,reject,timer:setTimeout(abort,300000)};
   signal?.addEventListener('abort',abort,{once:true});
   try{wire.send({type:'start',id:entry.id,direction,name,size,...(window>4?{window}:{}),...(direction==='upload'?{upload:uploadOptions(upload)}:{}),...(helper?{helper}:{})});}catch(err){settle(err);wire.close();}
  });
 }
 return{get ready(){return wire.ready&&!cancelingId;},get busy(){return !!active||!!cancelingId;},get progressing(){const age=active?.progressAt===undefined?Infinity:performance.now()-active.progressAt;return age>=0&&age<6000;},upload(file,options,signal,progress){return transfer('upload',file.name,file.size,file,options,signal,undefined,progress);},download(name,size,signal,progress){return transfer('download',name,size,undefined,undefined,signal,undefined,progress);},downloadHelper(helper,size,signal,progress){
  if(!helper||!Object.hasOwn(FORWARD_CLIENTS,helper.arch)||!Number.isSafeInteger(size)||size<=0||size>32*1024*1024)return Promise.reject(Object.assign(Error('助手下载参数无效'),{outcome:'rejected'}));
  return transfer('download',FORWARD_CLIENTS[helper.arch].name,size,undefined,undefined,signal,helper,progress);
 },close(){wire.close();}};
}
