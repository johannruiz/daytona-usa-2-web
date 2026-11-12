// Event-driven disclosure; no room messages, timers or per-frame work.
export function mountRoomInvitation({container,trigger,content,closeButton,initialFocus}){
 let available=false,open=false,native=typeof content.showPopover==='function',frame=0;
 if(native)content.setAttribute('popover','auto');
 container.classList.toggle('invite-fallback',!native);
 function position(){
  if(!open||!native)return;
  const anchor=trigger.getBoundingClientRect(),viewport=window.visualViewport;
  const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
  const w=Math.min(340,width-24),h=content.getBoundingClientRect().height;
  content.style.width=w+'px';
  content.style.left=Math.max(left+12,Math.min(anchor.right-w,left+width-w-12))+'px';
  content.style.top=Math.max(top+12,Math.min(anchor.bottom+8,top+height-h-12))+'px';
  content.style.maxHeight=Math.max(100,height-24)+'px';
 }
 function schedule(){if(open&&!frame)frame=requestAnimationFrame(()=>{frame=0;position();});}
 function close(restoreFocus=false){
  if(!open)return false;
  open=false;
  if(native&&content.matches(':popover-open'))content.hidePopover();
  content.hidden=true;trigger.setAttribute('aria-expanded','false');
  if(restoreFocus&&available)trigger.focus({preventScroll:true});
  return true;
 }
 function show(){
  if(!available||open)return;
  open=true;content.hidden=false;trigger.setAttribute('aria-expanded','true');
  if(native)content.showPopover();
  position();initialFocus.focus({preventScroll:true});
 }
 trigger.addEventListener('click',()=>open?close(true):show());
 closeButton.addEventListener('click',()=>close(true));
 content.addEventListener('toggle',event=>{if(event.newState==='closed')close(content.contains(document.activeElement));});
 document.addEventListener('pointerdown',event=>{if(open&&!container.contains(event.target))close();},{capture:true});
 document.addEventListener('focusin',event=>{if(open&&!container.contains(event.target))close();});
 document.addEventListener('keydown',event=>{
  if(!open)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
  else if(event.key==='Tab'){
   const controls=[...content.querySelectorAll('button,input,a[href],[tabindex="0"]')].filter(e=>!e.disabled&&e.getClientRects().length);
   const first=controls[0],last=controls.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
   event.stopPropagation();
  }
 },{capture:true});
 window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
 document.addEventListener('scroll',schedule,{capture:true,passive:true});
 return {close,isOpen:()=>open,setAvailable(value){available=!!value;if(!available)close();container.hidden=!available;},position};
}
