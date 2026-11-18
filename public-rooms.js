import {parseInvitation, SEATS} from './room.js';
import {BUILD_ID} from './version.js';
export {BUILD_ID};   // the game version (version.js): rooms of another version list as "Different version"
export const ROOM_TTL_MS=90000,ROOM_PULSE_MS=30000;
export const DIRECTORY_IDLE_MS=5*60*1000;
const states=new Set(['open','full','starting','racing','reconnecting']);
export const cleanRoomName=value=>String(value||'').replace(/\s+/gu,' ').trim().slice(0,48);
export function publicRoomPayload(s){
 if(!s.isHost||s.visibility!=='public'||!s.code||!['lobby','playing'].includes(s.phase)||!Array.isArray(s.members))return null;
 const players=s.members.filter(m=>!m.departed).length+(s.waiters||[]).length;
 return {name:cleanRoomName(s.roomName)||'Daytona 2 room',players:Math.min(SEATS,players),state:s.phase==='playing'?'racing':s.members.some(m=>m.connection==='reconnecting')?'reconnecting':players>=SEATS?'full':'open',invite:s.code,version:BUILD_ID};
}
export function readPublicRooms(value,now){
 if(!value||typeof value!=='object')return [];
 return Object.entries(value).flatMap(([id,r])=>{
  if(!/^[A-Z0-9]{5}$/.test(id)||!r||typeof r.ownerUid!=='string'||!r.ownerUid||typeof r.name!=='string'||!r.name.trim()||r.name.length>48||!Number.isInteger(r.players)||r.players<0||r.players>SEATS||!states.has(r.state)||typeof r.updatedAt!=='number'||!Number.isFinite(r.updatedAt)||now-r.updatedAt>ROOM_TTL_MS||r.updatedAt>now+10000||typeof r.version!=='string'||r.version.length>96)return [];
  try{const invite=parseInvitation(r.invite);if(invite!==id||r.invite!==id)return [];}catch{return [];}
  const compatible=r.version===BUILD_ID,joinable=compatible&&['open','starting','racing'].includes(r.state)&&r.players<SEATS;
  return [{id,name:r.name,players:r.players,state:r.state,invite:r.invite,updatedAt:r.updatedAt,compatible,joinable}];
 }).sort((a,b)=>Number(b.joinable)-Number(a.joinable)||Number(b.compatible)-Number(a.compatible)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
}
export function directoryError(e){
 const code=String(e?.code||'').toLowerCase();
 if(code.includes('app-check')||code.includes('appcheck')||code.includes('app-not-authorized'))return 'Could not verify this app. Open the official game page and retry. Private invitations still work.';
 if(code.includes('permission'))return 'Public rooms are unavailable. Access was denied by the room service. Open the official game page and retry.';
 if(code.includes('operation-not-allowed'))return 'Public rooms are unavailable. Enable Anonymous sign-in in Firebase.';
 if(code.includes('too-many'))return 'The room service is busy. Try again shortly.';
 return 'Could not reach public rooms. Check your connection and retry. Private invitations still work.';
}
const timeout=(p,ms=12000)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Directory timeout')),ms);Promise.resolve(p).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});});

// Firebase is directory metadata only. Never invokes stop/leave on the game.
export class PublicRoomDirectory {
 constructor({backend,changed=()=>{},now=()=>Date.now(),setTimer=(fn,ms)=>globalThis.setInterval(fn,ms),clearTimer=id=>globalThis.clearInterval(id)}={}){
  Object.assign(this,{factory:backend,changed,now,setTimer,clearTimer});this.raw={};this.offsetMs=0;this.browsing=false;this.pageVisible=true;this.paused=false;this.lastInteraction=this.now();this.connected=false;this.desired=null;this.hostId='';this.armed='';this.lastKey='';this.lastAt=-Infinity;this.lastAttempt=-Infinity;this.error='';this.listStatus='idle';this.hostStatus='idle';this.generation=0;
 }
 snapshot(){return {status:this.paused?'paused':this.listStatus,hostStatus:this.hostStatus,error:this.error,connected:this.connected,rooms:this.connected&&!this.paused?readPublicRooms(this.raw,this.now()+this.offsetMs):[]};}
 emit(){this.changed(this.snapshot());}
 async ensure(){
  if(!this.loading)this.loading=timeout(this.factory()).then(b=>{
   this.backend=b;this.unconnection=b.connection(connected=>{this.connected=connected;if(!connected){this.armed='';this.lastKey='';this.retryAt=0;this.lastAt=this.lastAttempt=-Infinity;if(this.desired)this.hostStatus='publishing';}else {this.error='';this.flush();}this.emit();});this.unoffset=b.offset(n=>{this.offsetMs=n;});return b;
  }).catch(e=>{this.loading=null;this.error=directoryError(e);this.listStatus='error';this.hostStatus=this.desired?'error':'idle';this.emit();throw e;});
  const b=await this.loading;if(this.desired||(this.browsing&&this.pageVisible&&!this.paused)){if(!this.dbOnline){this.dbOnline=true;b.online();}}else{this.dbOnline=false;b.offline();}return b;
 }
 async prepare(){await this.ensure();if(this.error)throw Error(this.error);}
 setBrowsing(value){value=!!value;if(value!==this.browsing){this.paused=false;this.lastInteraction=this.now();}this.browsing=value;this.activity();}
 interact(){if(this.browsing&&!this.paused)this.lastInteraction=this.now();}
 checkIdle(){if(this.browsing&&!this.desired&&!this.paused&&this.now()-this.lastInteraction>=DIRECTORY_IDLE_MS){this.paused=true;this.raw={};return true;}return false;}
 setVisible(value){this.pageVisible=!!value;this.activity();}
 updateHost(state){
  const payload=publicRoomPayload(state),id=payload?state.code:'';
  if(id!==this.hostId){const old=this.hostId;this.generation++;this.hostId=id;this.armed='';this.retryAt=0;this.hostStatus='idle';this.lastKey='';this.lastAt=this.lastAttempt=-Infinity;if(old)this.clearRoom(old);}
  this.desired=payload;this.hostStatus=payload?(this.hostStatus==='published'?'published':'publishing'):'idle';this.activity();
 }
 activity(){
  this.checkIdle();
  const listening=this.browsing&&this.pageVisible&&!this.paused,active=listening||!!this.desired;
  if(!active){this.unlisten?.();this.unlisten=null;this.listStatus='idle';if(this.timer)this.clearTimer(this.timer);this.timer=null;if(this.dbOnline){this.dbOnline=false;this.backend?.offline();}this.emit();return;}
  if(!this.timer)this.timer=this.setTimer(()=>{if(this.checkIdle())this.activity();else{this.flush();this.emit();}},15000);
  this.ensure().then(b=>{
   if(this.browsing&&this.pageVisible&&!this.paused&&!this.unlisten){this.listStatus='loading';this.unlisten=b.listen(raw=>{this.raw=raw;this.error='';this.listStatus='ready';this.emit();},e=>{this.error=directoryError(e);this.listStatus='error';this.unlisten?.();this.unlisten=null;this.emit();});}
   else if(!this.browsing||!this.pageVisible||this.paused){this.unlisten?.();this.unlisten=null;}
   this.flush();this.emit();
  }).catch(()=>{});
 }
 async clearRoom(id){
  if(!this.backend)return;
  try{this.backend.withdraw?.(id);}catch{} // Optional Discord service never gates room cleanup.
  try{await this.backend.remove(id);await this.backend.cancel(id);}catch{} // onDisconnect + TTL remain the fallback.
 }
 async flush(){
  if(!this.backend||!this.connected||!this.desired||this.writing)return;
  const key=JSON.stringify(this.desired),now=this.now();if(now<(this.retryAt||0)||(key===this.lastKey&&now-this.lastAt<ROOM_PULSE_MS)||now-this.lastAttempt<1500)return;
  const id=this.hostId,generation=this.generation,payload={...this.desired,ownerUid:this.backend.uid,updatedAt:this.backend.timestamp()};
  this.writing=true;this.lastAttempt=now;
  try{
   if(this.armed!==id){await timeout(this.backend.arm(id));if(generation!==this.generation)return;this.armed=id;}
   await timeout(this.backend.put(id,payload));
   if(generation!==this.generation){void this.clearRoom(id);return;}
   this.lastKey=key;this.lastAt=now;this.hostStatus='published';this.error='';
   try{this.backend.published?.(id);}catch{} // The backend deduplicates; pulses add no notification traffic.
  }catch(e){if(generation===this.generation){this.retryAt=this.now()+ROOM_PULSE_MS;this.hostStatus='error';this.error=directoryError(e);}}
  finally{this.writing=false;this.emit();if(generation!==this.generation)void this.flush();}
 }
 retry(){this.paused=false;this.lastInteraction=this.now();this.error='';this.retryAt=0;this.lastAttempt=-Infinity;this.unlisten?.();this.unlisten=null;this.activity();}
 dispose(){const id=this.hostId;this.hostId='';this.generation++;this.desired=null;this.browsing=false;if(id)void this.clearRoom(id);this.activity();this.unconnection?.();this.unoffset?.();}
}
