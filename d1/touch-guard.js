// Drive with Pointer Events; cancel the browser's parallel touch gestures.
export function bindTouchActivation(button,activate){
 let lastTouch=-Infinity;
 button.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch'&&event.pointerType!=='pen')return;
  event.preventDefault();lastTouch=performance.now();activate();
 });
 button.addEventListener('click',event=>{
  // Touch may still synthesize a click after pointerdown. Keyboard/AT clicks
  // (detail 0) and ordinary mouse clicks keep their normal activation path.
  if(event.detail>0&&performance.now()-lastTouch<800){event.preventDefault();return;}
  activate();
 });
}
export function protectTouchSurface(surface,{mobile=false}={}){
 const prevent=event=>{if(event.cancelable)event.preventDefault();};
 const options={capture:true,passive:false};
 // Do not gate touchend on running: opening the menu on pointerdown changes
 // that state before the same finger is lifted, which could leak a tap/zoom.
 for(const name of ['touchstart','touchmove','touchend','touchcancel','gesturestart','gesturechange','gestureend','dblclick','contextmenu','selectstart','dragstart'])surface.addEventListener(name,prevent,options);
 const clearSelection=()=>{
  const selection=document.getSelection();if(!selection||selection.isCollapsed)return;
  for(let i=0;i<selection.rangeCount;i++)if(selection.getRangeAt(i).intersectsNode(surface)){selection.removeAllRanges();break;}
 };
 surface.addEventListener('pointerdown',clearSelection,{capture:true});
 document.addEventListener('selectionchange',clearSelection);
 surface.setAttribute('draggable','false');
 if(mobile){
  document.documentElement.classList.add('mobile-gestures');
  const viewport=document.querySelector('meta[name="viewport"]');
  if(viewport)viewport.content='width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  // Pinches that start in the launcher also must not scale the game viewport.
  for(const name of ['gesturestart','gesturechange','gestureend'])document.addEventListener(name,prevent,options);
  for(const name of ['touchstart','touchmove'])document.addEventListener(name,event=>{if(event.touches?.length>1)prevent(event);},options);
 }
}
