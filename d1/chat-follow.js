// Follow new content and layout changes until the reader explicitly scrolls up.
// Resize/mutation callbacks coalesce into a single frame; no polling per frame.
export function createChatFollow(log,{onBottom=()=>{},schedule=fn=>requestAnimationFrame(fn),cancel=id=>cancelAnimationFrame(id)}={}){
 let following=true,frame=null,lastTop=0,lastHeight=0,lastClient=0,pointer=false,touchY=null;
 const bottom=()=>log.scrollTop+log.clientHeight>=log.scrollHeight-24;
 const visible=()=>log.clientHeight>0&&log.getClientRects().length>0;
 function remember(){lastTop=log.scrollTop;lastHeight=log.scrollHeight;lastClient=log.clientHeight;}
 function align(){if(!following||!visible())return;log.scrollTop=log.scrollHeight;remember();onBottom();}
 function refresh(){if(following&&frame===null)frame=schedule(()=>{frame=null;align();});}
 function latest(){following=true;align();refresh();}
 function reset(){following=true;lastTop=lastHeight=lastClient=0;refresh();}
 function pause(){if(visible()&&log.scrollHeight>log.clientHeight+24)following=false;}
 function scroll(){
  if(!visible())return;
  if(bottom()){following=true;onBottom();}
  else if(pointer||(log.scrollTop<lastTop-1&&log.scrollHeight===lastHeight&&log.clientHeight===lastClient))following=false;
  remember();
 }
 function wheel(event){if(event.deltaY<0)pause();}
 function key(event){if(['ArrowUp','PageUp','Home'].includes(event.key)||event.key===' '&&event.shiftKey)pause();}
 const down=()=>{pointer=true;},up=()=>{pointer=false;};
 const touchStart=event=>{touchY=event.touches[0]?.clientY??null;};
 const touchMove=event=>{const y=event.touches[0]?.clientY;if(touchY!==null&&y>touchY+2)pause();touchY=y??null;};
 log.addEventListener('scroll',scroll,{passive:true});log.addEventListener('wheel',wheel,{passive:true});log.addEventListener('keydown',key);
 log.addEventListener('pointerdown',down,{passive:true});log.addEventListener('pointerup',up,{passive:true});log.addEventListener('pointercancel',up,{passive:true});log.addEventListener('lostpointercapture',up,{passive:true});
 log.addEventListener('touchstart',touchStart,{passive:true});log.addEventListener('touchmove',touchMove,{passive:true});
 const resize=typeof ResizeObserver==='function'?new ResizeObserver(refresh):null;resize?.observe(log);
 const mutations=typeof MutationObserver==='function'?new MutationObserver(refresh):null;mutations?.observe(log,{childList:true,subtree:true,characterData:true});
 const doc=log.ownerDocument;doc?.addEventListener('pointerup',up,{passive:true});doc?.fonts?.addEventListener('loadingdone',refresh);
 remember();refresh();
 return {get following(){return following;},bottom,refresh,latest,reset,
  dispose(){if(frame!==null)cancel(frame);resize?.disconnect();mutations?.disconnect();doc?.removeEventListener('pointerup',up);doc?.fonts?.removeEventListener('loadingdone',refresh);for(const [type,fn] of [['scroll',scroll],['wheel',wheel],['keydown',key],['pointerdown',down],['pointerup',up],['pointercancel',up],['lostpointercapture',up],['touchstart',touchStart],['touchmove',touchMove]])log.removeEventListener(type,fn);}
 };
}
