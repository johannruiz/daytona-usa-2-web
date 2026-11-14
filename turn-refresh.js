// Renew a selected TURN allocation using the existing reliable data channel.
// PeerJS's public connection/peerConnection objects are used; its signaling
// socket and private negotiator are left alone. Existing SCTP channels survive.
export function attachTurnRefresh(conn,{localId,prepare,onEvent=()=>{}}){
 let supported=false,closed=false,busy=false,last=-Infinity,requestAt=-Infinity,pending=null,timeout=null;
 const pc=conn.peerConnection,initiator=String(localId)<String(conn.peer);
 if(!pc?.addEventListener||!conn.on)return {refresh:async()=>{},stop:()=>{}};
 const send=(action,fields={})=>{if(!closed&&conn.open)conn.send({type:'turn-refresh',version:1,action,...fields});};
 let savedCandidate=null,muted=false;
 const mute=()=>{if(!muted){savedCandidate=pc.onicecandidate;pc.onicecandidate=null;muted=true;}};
 const restore=()=>{if(muted){pc.onicecandidate=savedCandidate;muted=false;}};
 const finish=()=>{clearTimeout(timeout);timeout=null;pending=null;busy=false;restore();};
 const gathered=()=>new Promise((resolve,reject)=>{
  if(pc.iceGatheringState==='complete')return resolve();
  const done=()=>{if(pc.iceGatheringState==='complete'){cleanup();resolve();}};
  const cleanup=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',done);};
  const timer=setTimeout(()=>{cleanup();reject(Error('TURN gathering timed out.'));},12000);
  pc.addEventListener('icegatheringstatechange',done);done();
 });
 const configure=async()=>{const next=await prepare();if(closed||!next.relay)throw Error('TURN renewal unavailable.');pc.setConfiguration({...pc.getConfiguration(),iceServers:next.iceServers});};
 const relay=async()=>{
  const stats=await pc.getStats(),transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId),pair=stats.get(transport?.selectedCandidatePairId);
  return stats.get(pair?.localCandidateId)?.candidateType==='relay'||stats.get(pair?.remoteCandidateId)?.candidateType==='relay';
 };
 const rollback=async()=>{try{if(pc.signalingState==='have-local-offer')await pc.setLocalDescription({type:'rollback'});else if(pc.signalingState==='have-remote-offer')await pc.setRemoteDescription({type:'rollback'});}catch{}finish();onEvent('turn-refresh-retry');};
 const start=async()=>{
  if(closed||!supported||busy||Date.now()-last<60000||pc.signalingState!=='stable'||!await relay())return;
  if(!initiator){if(Date.now()-requestAt>=60000){requestAt=Date.now();send('request');}return;}
  last=Date.now();
  busy=true;try{
   await configure();if(closed)return finish();mute();
   pending=crypto.randomUUID();await pc.setLocalDescription(await pc.createOffer({iceRestart:true}));await gathered();
   if(closed)return finish();send('offer',{id:pending,sdp:pc.localDescription.sdp});
   timeout=setTimeout(()=>void rollback(),20000);
  }catch{await rollback();}
 };
 const message=async data=>{
  if(closed||data?.type!=='turn-refresh'||data.version!==1)return;
  if(data.action==='hello'){supported=true;onEvent('turn-refresh-ready');return;}
  if(!supported)return;
  if(data.action==='request'){if(initiator)await start();return;}
  if(typeof data.id!=='string'||data.id.length>64||typeof data.sdp!=='string'||data.sdp.length>65536)return;
  try{
   if(data.action==='offer'&&!initiator&&!busy&&Date.now()-last>=60000&&pc.signalingState==='stable'){
    last=Date.now();busy=true;await configure();if(closed)return finish();mute();
    await pc.setRemoteDescription({type:'offer',sdp:data.sdp});await pc.setLocalDescription(await pc.createAnswer());await gathered();
    if(!closed){send('answer',{id:data.id,sdp:pc.localDescription.sdp});onEvent('turn-refreshed');}finish();
   }else if(data.action==='answer'&&initiator&&busy&&data.id===pending&&pc.signalingState==='have-local-offer'){
    await pc.setRemoteDescription({type:'answer',sdp:data.sdp});finish();onEvent('turn-refreshed');
   }
  }catch{await rollback();}
 };
 // EventEmitter does not await callbacks. Keep rejected promises contained.
 const data=d=>void message(d).catch(()=>{}),open=()=>send('hello');
 const stop=()=>{closed=true;finish();conn.off?.('data',data);conn.off?.('open',open);conn.off?.('close',stop);};
 conn.on('data',data);conn.on('open',open);conn.on('close',stop);if(conn.open)open();
 return {refresh:start,stop};
}
