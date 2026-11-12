// Prompt the last unready driver immediately; never replay stored chat history.
export function createLobbyNotifications({notifyChat=()=>{},notifyReady=()=>{},notifyConfirmed=()=>{},visible=()=>!document.hidden,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),initialDelay=0,repeatDelay=3000}={}){
 let key='',baseline=false,lastChat=0,state=null,timer=null,readyMembers=new Map();
 const eligible=()=>{
  if(!state||state.phase!=='lobby'||state.awaitingStop||state.readyPending||state.pending?.length||state.members.length<2)return false;
  const me=state.members.find(m=>m.id===state.id);
  return !!me&&!me.ready&&state.members.every(m=>m.connection!=='reconnecting'&&(m.id===state.id||m.ready));
 };
 const stop=()=>{if(timer!==null)cancel(timer);timer=null;};
 function remind(){timer=null;if(!eligible())return;notifyReady();timer=schedule(remind,repeatDelay);}
 return {
  update(next){
   state=next;const nextKey=(next.host||'')+':'+next.id;
   if(nextKey!==key){key=nextKey;baseline=false;lastChat=0;readyMembers.clear();stop();}
   const admitted=next.members.some(m=>m.id===next.id),inLobby=(next.phase==='lobby'&&(admitted||next.spectating)||next.phase==='waiting');
   const newest=Math.max(0,...(next.chat||[]).map(m=>m.seq));
   if(inLobby&&baseline&&next.members.some(m=>m.ready&&readyMembers.has(m.id)&&!readyMembers.get(m.id)))notifyConfirmed();
   readyMembers=new Map(next.members.map(m=>[m.id,!!m.ready]));
   if(inLobby&&baseline&&(next.chat||[]).some(m=>m.seq>lastChat&&m.sender!==next.id))notifyChat();
   lastChat=Math.max(lastChat,newest);baseline=inLobby;
   if(!eligible())stop();else if(timer===null){if(initialDelay<=0)remind();else timer=schedule(remind,initialDelay);}
  },
  dispose(){stop();state=null;baseline=false;}
 };
}
