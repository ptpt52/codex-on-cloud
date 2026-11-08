import { createFileWire, sendFileChunks, FILE_CHUNK, FILE_MAX } from './file-wire.js';
import { uploadOptions, uploadResult } from './file-upload.js';
export function createFileClient(channel, failed = () => {}) {
 let active,id=0,recoverable=false;
 const unknown=()=>Object.assign(Error('文件直连已断开，结果未知；请检查文件状态后手动重试'),{outcome:'unknown'});
 const settle=(err,result)=>{if(!active)return;const entry=active;active=null;clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);err?entry.reject(err):entry.resolve(result);};
 const wire=createFileWire(channel,{failed(err){settle(err);failed(recoverable);},chunk(bytes){
  if(!active||active.direction!=='download'||!active.started||active.received+bytes.length>active.size||active.received+bytes.length>FILE_MAX)throw unknown();
  active.received+=bytes.length;active.chunks.push(bytes.slice());
 },control(value){
  const entry=active;if(!entry||value.id!==entry.id)throw unknown();
  if(value.type==='error'){
   recoverable=value.recoverable===true&&[404,409,412,413,429,507].includes(value.status);
   settle(Object.assign(Error(typeof value.message==='string'?value.message:'文件传输失败'),{status:Number.isInteger(value.status)?value.status:502,outcome:recoverable?'rejected':'unknown'}));wire.close();return;
  }
  if(value.type==='ready'){
   if(entry.started||!Number.isSafeInteger(value.size)||value.size<0||value.size>FILE_MAX||entry.direction==='upload'&&value.size!==entry.size)throw unknown();
   entry.started=true;entry.size=value.size;
   if(entry.direction==='upload')void(async()=>{
    async function* source(){for(let offset=0;offset<entry.file.size;offset+=FILE_CHUNK){if(active!==entry)throw unknown();yield new Uint8Array(await entry.file.slice(offset,offset+FILE_CHUNK).arrayBuffer());}}
    await sendFileChunks(source(),wire,()=>active===entry);if(active===entry)wire.send({type:'end',id:entry.id});
   })().catch(err=>{settle(err);wire.close();});
   return;
  }
  if(value.type!=='done'||!entry.started||entry.direction==='download'&&(entry.received!==entry.size||value.size!==entry.size))throw unknown();
  settle(null,entry.direction==='download'?new Blob(entry.chunks,{type:'application/octet-stream'}):uploadResult({ok:true,name:value.name}));
 }});
 function transfer(direction,name,size,file,upload,signal){
  if(signal?.aborted)return Promise.reject(signal.reason||unknown());
  if(!wire.ready||active||id>=2147483647||!Number.isSafeInteger(size)||size<0||size>FILE_MAX)return Promise.reject(Object.assign(Error('文件直连繁忙、未就绪或文件超过 50 MiB'),{outcome:'rejected'}));
  return new Promise((resolve,reject)=>{
   const abort=()=>{settle(unknown());wire.close();};
   const entry=active={id:++id,direction,size,file,received:0,chunks:[],started:false,signal,abort,resolve,reject,timer:setTimeout(abort,300000)};
   signal?.addEventListener('abort',abort,{once:true});
   try{wire.send({type:'start',id:entry.id,direction,name,size,...(direction==='upload'?{upload:uploadOptions(upload)}:{})});}catch(err){settle(err);wire.close();}
  });
 }
 return{get ready(){return wire.ready;},get busy(){return !!active;},upload(file,options,signal){return transfer('upload',file.name,file.size,file,options,signal);},download(name,size){return transfer('download',name,size);},close(){wire.close();}};
}
