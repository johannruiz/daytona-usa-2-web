import {createChatFollow} from './chat-follow.js?v=53.8.59';
// Shared bounded room history. DOM updates follow real changes, not heartbeats.
export function mountGameChat(root,{room,storage,gameShown=()=>false,notify=()=>{},onTyping=()=>{},onRead=()=>{},returnFocus=()=>{}}){
 const find=id=>root.querySelector('#'+id),panel=find('gameChatPanel'),toggle=find('gameChatToggle'),badge=find('gameChatUnread'),log=find('gameChatLog'),input=find('gameChatInput'),send=find('gameChatSend'),feedback=find('gameChatFeedback'),newer=find('gameChatNew'),empty=find('gameChatEmpty');
 let collapsed=false;try{collapsed=storage?.getItem('daytona-game-chat-collapsed-v1')==='1';}catch{}
 let key='',baseline=false,lastSeq=0,unread=0,shown=false,lastAck=0,lastRead=0,lastUpdate=-Infinity,displayKey='',historyKey='',unreadKey='';const nodes=new Map();
 // Follow the usable viewport when the phone keyboard or browser bars move.
 // Update only on open/resize/viewport scroll, never on the simulation loop.
 let viewportKey='',viewportFrame=0;
 function layoutViewport(){
  viewportFrame=0;if(!shown||collapsed||!matchMedia('(pointer:coarse)').matches)return;
  const viewport=window.visualViewport,height=Math.max(1,viewport?.height||innerHeight),offset=Math.max(0,viewport?.offsetTop||0);
  const cramped=height<260,margin=cramped?4:12;
  let bottom=offset+height-margin;
  // Portrait has room above the pedals; keep the controls reachable there.
  // A small/keyboard-reduced viewport keeps the larger overlay instead.
  if(matchMedia('(orientation:portrait)').matches){
   const controls=document.querySelector('.touch-gears'),box=controls?.getClientRects().length?controls.getBoundingClientRect():null;
   const dock=box?Math.min(bottom,box.top-margin):bottom;
   if(dock-offset-margin>=280)bottom=dock;
  }
  const panelHeight=Math.max(1,Math.min(460,bottom-offset-margin)),top=Math.max(offset,bottom-panelHeight);
  const stamp=`${top}:${panelHeight}`;if(stamp===viewportKey)return;viewportKey=stamp;root.classList.toggle('chat-short-viewport',cramped);
  root.style.setProperty('--chat-panel-top',top+'px');root.style.setProperty('--chat-panel-height',panelHeight+'px');follow.refresh();
 }
 function viewportChanged(){if(shown&&!collapsed&&!viewportFrame)viewportFrame=requestAnimationFrame(layoutViewport);}
 window.visualViewport?.addEventListener('resize',viewportChanged);
 window.visualViewport?.addEventListener('scroll',viewportChanged);
 window.addEventListener('resize',viewportChanged);
 const bottom=()=>log.scrollTop+log.clientHeight>=log.scrollHeight-24;
 const follow=createChatFollow(log,{onBottom:()=>{if(shown&&!collapsed&&!document.hidden)read();}});
 const typing=()=>document.activeElement===input;
 function read(){if(unread){unread=0;paintUnread();}if(lastSeq>lastRead){lastRead=lastSeq;onRead();}}
 function paintUnread(){
  const stamp=`${unread}:${collapsed}:${follow.following}`;if(stamp===unreadKey)return;unreadKey=stamp;
  badge.hidden=!unread;badge.textContent=unread>99?'99+':String(unread);
  toggle.setAttribute('aria-label',`Show room chat${unread?`, ${unread} unread messages`:''}`);
  newer.hidden=!unread||collapsed||follow.following;newer.textContent=unread?`${unread} new message${unread===1?'':'s'} ↓`:'New messages ↓';
 }
 function latest(){follow.latest();read();}
 function collapse(value,focus=true){
  collapsed=value;try{storage?.setItem('daytona-game-chat-collapsed-v1',value?'1':'0');}catch{}
  update(true);paintUnread();if(focus){if(value)returnFocus();else input.focus({preventScroll:true});}if(!value)follow.refresh();
 }
 // Pointer users open the history without summoning the mobile keyboard.
 toggle.onclick=event=>collapse(false,event.detail===0);find('gameChatHide').onclick=()=>collapse(true);newer.onclick=latest;
 // Focusing an absolute overlay can scroll its containing block before click.
 newer.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});
 log.addEventListener('scroll',()=>{if(shown&&!collapsed&&bottom())read();});
 root.addEventListener('focusin',()=>{if(typing())onTyping();});
 root.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();collapse(true);}});
 input.addEventListener('input',()=>{send.disabled=!room.chatAllowed(room.id)||!input.value.trim();});
 find('gameChatForm').addEventListener('submit',event=>{
  event.preventDefault();try{if(room.submitChat(input.value)){input.value='';send.disabled=true;feedback.textContent=room.isHost?'Message sent.':'Sending…';latest();input.focus({preventScroll:true});}}catch(e){feedback.textContent=e.message;}
 });
 function update(force=false){
  const now=performance.now();if(!force&&now-lastUpdate<100)return;lastUpdate=now;
  const available=room.active&&room.chatAllowed(room.id),next=available&&gameShown();
  if(shown!==next){shown=next;root.hidden=!next;if(next&&!collapsed){layoutViewport();follow.refresh();}if(!next&&root.contains(document.activeElement)){document.activeElement.blur();if(gameShown())returnFocus();}}
  const stamp=`${next}:${collapsed}:${available}`;
  if(stamp!==displayKey){displayKey=stamp;root.classList.toggle('chat-collapsed',collapsed);panel.hidden=!next||collapsed;toggle.hidden=!next||!collapsed;toggle.setAttribute('aria-expanded',String(!collapsed));input.disabled=!available;send.disabled=!available||!input.value.trim();if(next&&!collapsed)layoutViewport();}
  if(next&&!collapsed&&!document.hidden&&bottom())read();
  const lobby=document.getElementById('chatLog');if(unread&&!document.hidden&&lobby?.getClientRects().length&&lobby.scrollTop+lobby.clientHeight>=lobby.scrollHeight-24)read();
 }
 function sync(state){
  const nextKey=(state.host||'')+':'+state.id;
  if(key!==nextKey){key=nextKey;displayKey='';historyKey='';unreadKey='';baseline=false;lastSeq=0;lastAck=0;lastRead=0;unread=0;nodes.clear();log.replaceChildren();follow.reset();input.value='';feedback.textContent='Chat pauses during the race.';paintUnread();}
  const chat=state.chat||[],stamp=`${chat.length}:${chat[0]?.seq||0}:${chat.at(-1)?.seq||0}`;
  if(stamp!==historyKey){
   historyKey=stamp;const visible=shown&&!collapsed,nearBottom=follow.following,wanted=new Set(chat.map(m=>m.seq));
   const logTop=visible&&!nearBottom?log.getBoundingClientRect().top:0;
   const anchor=visible&&!nearBottom?[...nodes.values()].find(node=>node.getBoundingClientRect().bottom>logTop):null;
   const anchorTop=anchor?.getBoundingClientRect().top;let added=0,own=false;
   for(const [seq,node] of nodes)if(!wanted.has(seq)){node.remove();nodes.delete(seq);}
   for(const m of chat){
    if(nodes.has(m.seq))continue;
    const li=document.createElement('li'),head=document.createElement('div'),name=document.createElement('strong'),time=document.createElement('time'),text=document.createElement('p');
    li.className='chat-message'+(m.sender===state.id?' own-message':'');name.textContent=m.sender===state.id?'You':m.name;time.dateTime=new Date(m.time).toISOString();time.textContent=new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});head.append(name,time);text.textContent=m.text;li.append(head,text);log.append(li);nodes.set(m.seq,li);
    if(baseline&&m.seq>lastSeq){if(m.sender!==state.id)added++;else own=true;}
   }
   lastSeq=Math.max(lastSeq,...chat.map(m=>m.seq),0);unread+=added;empty.hidden=chat.length>0;
   if(added&&room.active&&room.chatAllowed(room.id)&&!document.hidden)notify();
   if(own)latest();else if(nearBottom)follow.refresh();
   else if(anchor&&log.contains(anchor))log.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
  }
  baseline=state.members.some(m=>m.id===state.id)||!!state.waitingForRace;
  if(state.lastAck?.action==='chat-submit'&&state.lastAck.command>lastAck){lastAck=state.lastAck.command;feedback.textContent=state.lastAck.accepted?'Confirmed by host.':state.lastAck.reason;}
  paintUnread();update(true);
 }
 return {sync,update,typing,hide:()=>collapse(true),get unread(){return unread;}};
}
