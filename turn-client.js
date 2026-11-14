import {attachTurnRefresh} from './turn-refresh.js';
import {validateIceServers} from './turn-policy.js';
export const TURN_ENDPOINT='https://daytona2-turn.sebiches1.workers.dev/ice-servers';
export const DEFAULT_ICE=Object.freeze([{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]);
export function createTurnClient({endpoint=TURN_ENDPOINT,fetcher=globalThis.fetch,clock=()=>Date.now(),timeout=8500}={}){
 let cached=null,pending=null,retryAt=0;
 return {async configuration(){
  if(cached&&cached.expiresAt>clock()+1200000)return {...cached,relay:true};
  if(clock()<retryAt)return {iceServers:DEFAULT_ICE,relay:false};
  if(pending)return pending;
  pending=(async()=>{
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout);
   try{
    const response=await fetcher(endpoint,{method:'POST',headers:{'X-Daytona-Turn':'1'},signal:abort.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
    if(!response.ok)throw Error('Relay unavailable.');
    const value=await response.json(),iceServers=validateIceServers(value.iceServers);
    if(!Number.isFinite(value.expiresAt)||value.expiresAt<=clock()+1200000||value.expiresAt>clock()+10800000)throw Error('Invalid relay expiry.');
    cached={iceServers,expiresAt:value.expiresAt};return {...cached,relay:true};
   }catch{retryAt=clock()+60000;return {iceServers:DEFAULT_ICE,relay:false};}
   finally{clearTimeout(timer);pending=null;}
  })();return pending;
 }};
}
export const turnClient=createTurnClient();

export function maintainIceConfiguration(peer,initial,{prepare=()=>turnClient.configuration(),clock=()=>Date.now(),schedule=setTimeout,cancel=clearTimeout,onChange=()=>{},onRefresh=()=>{}}={}){
 let stopped=false,timer,renewalFailed=false;const rotations=new Map(),connect=peer.connect;
 const event=(kind,conn)=>{onRefresh(kind,conn);if(kind==='turn-refresh-retry'&&!stopped){renewalFailed=true;cancel(timer);arm({relay:false});}};
 const attach=conn=>{if(!rotations.has(conn)){rotations.set(conn,attachTurnRefresh(conn,{localId:peer.id,prepare,onEvent:kind=>event(kind,conn)}));conn.on?.('close',()=>rotations.delete(conn));}return conn;};
 const incoming=conn=>attach(conn);peer.on?.('connection',incoming);
 if(connect)peer.connect=function(...args){return attach(connect.apply(this,args));};
 const apply=async value=>{
  const config={...peer.options.config,iceServers:value.iceServers};peer.options.config=config;
  const pcs=new Set(Object.values(peer.connections||{}).flat().map(c=>c.peerConnection).filter(Boolean));
  for(const pc of pcs)if(pc.signalingState!=='closed')try{pc.setConfiguration({...pc.getConfiguration(),iceServers:value.iceServers});}catch{}
  for(const conn of Object.values(peer.connections||{}).flat()){
   if(conn.open&&conn.peerConnection){attach(conn);if(value.relay)await rotations.get(conn).refresh();}
  }
 };
 const arm=value=>{
  if(stopped||peer.destroyed)return;
  const delay=renewalFailed?60000:value.relay?Math.max(60000,value.expiresAt-clock()-1200000):300000;
  timer=schedule(async()=>{
   try{const next=await prepare();if(stopped||peer.destroyed)return;renewalFailed=false;await apply(next);onChange(next);cancel(timer);arm(next);}
   catch{arm({relay:false});}
  },delay);timer?.unref?.();
 };
 for(const conn of Object.values(peer.connections||{}).flat())attach(conn);
 arm(initial);return ()=>{stopped=true;cancel(timer);peer.off?.('connection',incoming);if(connect)peer.connect=connect;for(const r of rotations.values())r.stop();rotations.clear();};
}
