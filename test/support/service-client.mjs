import { RTCPeerConnection } from 'werift';
import { randomBytes } from 'node:crypto';
import { sendControl, controlDecoder } from '../../panel/public/control.js';
export async function serviceClient(app,{username='visitor',password='temporary-test-password',hints}={}) {
 const viewer=randomBytes(16).toString('hex');let cookie='',csrf='';
 const request=(path,body,extra={})=>fetch(app.config.origin+path,{method:body===undefined?'GET':'POST',headers:{origin:app.config.origin,cookie,'x-csrf-token':csrf,'x-viewer-id':viewer,'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
 const login=await request('/api/login',{username,password});if(login.status!==200)throw Error('test login failed');cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 const peer=new RTCPeerConnection({iceServers:[],iceUseIpv4:true,iceUseIpv6:false,iceUseTcp:false,iceInterfaceAddresses:{udp4:'127.0.0.1'}});
 const channel=peer.createDataChannel('codex-service',{ordered:true,protocol:'service-v1'});let sequence=0,pending;
 const decoder=controlDecoder(value=>{pending?.resolve(value);pending=null;},()=>pending?.reject(Error('invalid record')));channel.onMessage.subscribe(bytes=>decoder.push(bytes));
 for(const transport of peer.iceTransports)transport.connection.stunServer=undefined;
 const opened=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('service DTLS deadline')),6000);channel.stateChange.subscribe(state=>{if(state==='open'){clearTimeout(timer);resolve();}});});
 try{
  await peer.setLocalDescription(await peer.createOffer());const res=await request('/api/service/rtc',{...peer.localDescription,...(hints?{hints}:{})});
  if(res.status!==200)throw Error('service negotiation HTTP '+res.status);await peer.setRemoteDescription(await res.json());await opened;
 }catch(err){await peer.close();throw err;}
 return {peer,channel,request,viewer,headers:{origin:app.config.origin,cookie,'x-csrf-token':csrf,'x-viewer-id':viewer},
  rpc(action,body={}){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC deadline')),8000);pending={resolve:v=>{clearTimeout(timer);resolve(v);},reject};sendControl(channel,{id:++sequence,action,body});});},close:()=>peer.close()};
}
