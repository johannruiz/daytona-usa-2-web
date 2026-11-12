// Menu commands deliberately use standard physical controls, never race bindings.
const UI_BUTTONS=[0,1,4,5,12,13,14,15,16];
const DPAD_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z"/></svg>';
const down=(pad,index)=>!!pad?.buttons[index]?.pressed||(pad?.buttons[index]?.value||0)>.5;
const controls='button,input:not([type="file"]),select,textarea,a[href],summary,[tabindex],[role="button"]';
const eligible=node=>!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&!node.closest('[hidden],[inert]')&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';
export function mountMenuGamepad({root,hints,getPad,isOpen,isCapturing,back,backLabel,isFocused=()=>document.hasFocus()&&!document.hidden}){
 let key='',previous=new Set(),opened=false,mode=false,waitForNeutral=true,releasePending=false,captureSeen=false;
 let direction='',repeatAt=0,editing=null,testing=null,focused=null,hintHTML='',focusIndex=0;
 const scope=()=>root.querySelector('[data-menu-popover]:not([hidden])')||root;
 const items=()=>[...scope().querySelectorAll(controls)].filter(node=>eligible(node)&&node.tabIndex>=0);
 const neutral=pad=>!UI_BUTTONS.some(i=>down(pad,i))&&Math.abs(pad?.axes[0]||0)<.35&&Math.abs(pad?.axes[1]||0)<.35;
 function clearFocus(){focused?.classList.remove('gamepad-focus');focused=null;}
 function options(node){return [...node.options].filter(o=>!o.disabled&&!(o.parentElement?.tagName==='OPTGROUP'&&o.parentElement.disabled));}
 function positionPicker(){
  if(!editing)return;const {node,popup,list}=editing,r=node.getBoundingClientRect();
  const height=Math.min(300,innerHeight-24),below=innerHeight-r.bottom-12,above=r.top-12;
  const showBelow=below>=Math.min(height,180)||below>=above,available=Math.max(60,Math.min(height,showBelow?below:above)),width=Math.min(Math.max(r.width,240),innerWidth-24);
  popup.style.width=width+'px';popup.style.maxHeight=available+'px';popup.style.left=Math.max(12,Math.min(r.left,innerWidth-width-12))+'px';
  popup.style.top=Math.max(12,showBelow?r.bottom+6:r.top-available-6)+'px';
  list.style.maxHeight=Math.max(24,available-44)+'px';
 }
 function renderPicker(){
  if(!editing)return;const {node,popup,list,draft}=editing,choices=options(node);
  if(!choices.some(o=>o.value===draft)){stopEditing(true);return;}
  list.replaceChildren(...choices.map((o,i)=>{const item=document.createElement('div');item.className='gamepad-select-option';item.id=`gamepad-choice-${i}`;item.setAttribute('role','option');item.setAttribute('aria-selected',String(o.value===draft));item.textContent=o.textContent;return item;}));
  const selected=list.querySelector('[aria-selected="true"]');node.setAttribute('aria-activedescendant',selected.id);positionPicker();selected.scrollIntoView({block:'nearest'});
 }
 function startEditing(node){
  const popup=document.createElement('div'),title=document.createElement('div'),list=document.createElement('div');
  popup.className='gamepad-select-popup';title.className='gamepad-select-title';title.textContent='Choose an option · A confirm · B cancel';list.id='gamepad-select-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',node.getAttribute('aria-label')||node.labels?.[0]?.childNodes[0]?.textContent?.trim()||'Options');
  popup.append(title,list);(node.closest('#integratedSpectator[open]')?.querySelector('#spectatorShell')||document.body).append(popup);editing={node,draft:node.value,popup,list};node.classList.add('gamepad-editing');node.setAttribute('aria-expanded','true');node.setAttribute('aria-controls',list.id);renderPicker();
 }
 function stopEditing(cancel=false){
  if(!editing)return;const {node,draft,popup}=editing;editing=null;popup.remove();node.classList.remove('gamepad-editing');node.removeAttribute('aria-expanded');node.removeAttribute('aria-controls');node.removeAttribute('aria-activedescendant');
  // The draft never modifies the form or shared room settings until A confirms.
  if(!cancel&&eligible(node)&&options(node).some(o=>o.value===draft)&&node.value!==draft){node.value=draft;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}
 }

 function stopTesting(){testing?.classList.remove('gamepad-editing');testing=null;}
 function hide(){mode=false;hints.hidden=true;document.documentElement.classList.remove('gamepad-navigation');clearFocus();}
 function focus(node){if(!node)return;focusIndex=Math.max(0,items().indexOf(node));clearFocus();node.focus({preventScroll:true});focused=node;node.classList.add('gamepad-focus');node.scrollIntoView({block:'nearest',inline:'nearest'});}
 function active(){const node=document.activeElement;return scope().contains(node)&&eligible(node)&&node.matches(controls)?node:null;}
 function target(){let node=active();if(!node){const all=items();node=all[Math.min(focusIndex,all.length-1)];focus(node);}else if(focused!==node)focus(node);return node;}
 function tabList(){
  const node=active(),nested=node?.closest('[role="tablist"]');
  const groups=[...scope().querySelectorAll('[role="tablist"]')].filter(eligible);
  return nested&&eligible(nested)?nested:groups.find(g=>g.parentElement?.contains(node))||groups[0]||null;
 }
 function renderHints(){
  if(!mode||!isOpen()){hints.hidden=true;return;}
  let html;
  const badge=(key,text,cls='')=>`<span class="pad-hint"><span class="pad-key ${cls}" aria-hidden="true">${key}</span><span>${text}</span></span>`;
  if(isCapturing())html='<span class="pad-capture-hint">Assign input · menu navigation paused · Esc cancels</span>';
  else if(testing)html='<span class="pad-capture-hint">Live input test</span>'+badge('B','Done','pad-b');
  else{
   const node=active();html=badge(DPAD_ICON,editing?'Change':node?.type==='range'?'Move / adjust':'Move','pad-direction');
   const action=editing?'Confirm':node?.matches('.seat-move')?'Move here':node?.matches('select')?'Change':node?.type==='range'?'Done':node?.matches('[data-gamepad-test]')?'Test':node?.matches('input[type="checkbox"],input[type="radio"]')?'Toggle':node?.matches('input,textarea')?'Enter text':'Select';
   html+=badge('A',action,'pad-a');const label=editing?'Cancel':backLabel();if(label)html+=badge('B',label,'pad-b');
   if(tabList())html+=badge('LB / RB','Tabs','pad-shoulders');
   if(node?.id==='dropzone')html+='<span class="pad-capture-hint">Choose file with mouse or keyboard</span>';
  }
  if(html!==hintHTML){hints.innerHTML=html;hintHTML=html;}hints.hidden=false;
 }
 function use(){mode=true;document.documentElement.classList.add('gamepad-navigation');target();renderHints();}
 function move(dir){
  const node=target();if(!node)return;
  if(editing){
   const choices=options(editing.node),at=choices.findIndex(o=>o.value===editing.draft);
   const next=choices[Math.max(0,Math.min(choices.length-1,at+(['right','down'].includes(dir)?1:-1)))];
   if(next){editing.draft=next.value;renderPicker();}return;
  }
  if(node.type==='range'&&['left','right'].includes(dir)){
   const old=node.value;dir==='left'?node.stepDown():node.stepUp();if(node.value!==old){node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}return;
  }
  if(node.getAttribute('role')==='tab'&&['left','right'].includes(dir)){switchTab(dir==='left'?-1:1);return;}
  const all=items(),at=all.indexOf(node);
  // Vertical navigation follows form order: every visible control is reachable,
  // including controls in a different column or below a scroll boundary.
  if(['up','down'].includes(dir)){focus(all[Math.max(0,Math.min(all.length-1,at+(dir==='down'?1:-1)))]);return;}
  const box=n=>n.matches('input[type="radio"],input[type="checkbox"]')&&n.closest('label')?n.closest('label').getBoundingClientRect():n.getBoundingClientRect();
  const current=box(node),cx=current.x+current.width/2,cy=current.y+current.height/2,sign=dir==='right'?1:-1;
  const candidates=all.filter(n=>n!==node).map(n=>{const r=box(n),dx=(r.x+r.width/2-cx)*sign,dy=Math.abs(r.y+r.height/2-cy);return {node:n,dx,dy,overlap:Math.min(r.bottom,current.bottom)-Math.max(r.top,current.top),score:dx+dy*3};}).filter(x=>x.dx>4&&x.overlap>4).sort((a,b)=>a.score-b.score);
  if(candidates.length)focus(candidates[0].node);
 }
 function switchTab(delta){
  stopEditing(true);stopTesting();const group=tabList();if(!group)return;
  const tabs=[...group.querySelectorAll('[role="tab"]')].filter(eligible);if(!tabs.length)return;
  const at=tabs.findIndex(t=>t.getAttribute('aria-selected')==='true'),next=tabs[(Math.max(0,at)+delta+tabs.length)%tabs.length];next.click();focus(next);
 }
 function accept(){
  if(editing){stopEditing();return;}
  const node=target();if(!node)return;
  if(node.matches('[data-gamepad-test]')){testing=node;node.classList.add('gamepad-editing');return;}
  if(node.matches('select')){startEditing(node);return;}
  if(node.type==='range'){move('down');return;}
  if(node.matches('input:not([type="checkbox"]):not([type="radio"]),textarea')){node.focus();return;}
  node.click();
 }
 function pointer(){if(!mode)return;stopEditing(true);stopTesting();waitForNeutral=true;hide();}
 window.addEventListener('pointerdown',pointer,{capture:true});window.addEventListener('pointermove',pointer,{passive:true});window.addEventListener('keydown',pointer,{capture:true});
 root.addEventListener('focusin',()=>{if(mode){const node=active();if(node&&node!==focused){clearFocus();focused=node;node.classList.add('gamepad-focus');}renderHints();}});
 function update(now){
  const open=isOpen();
  // Race frames need no DOM scan or extra pad polling once UI buttons release.
  if(!open&&!opened&&!releasePending)return;
  const pad=getPad(),nextKey=pad?`${pad.index}:${pad.id}`:'',pressed=new Set(UI_BUTTONS.filter(i=>down(pad,i))),capturing=isCapturing();
  document.documentElement.classList.toggle('menu-gamepad-connected',!!pad);
  if(nextKey!==key){key=nextKey;previous=pressed;waitForNeutral=true;direction='';hide();}
  if(!pad||!isFocused()){opened=open;previous=pressed;waitForNeutral=true;stopEditing(true);stopTesting();hide();return;}
  if(!open){if(opened)releasePending=!neutral(pad);if(neutral(pad))releasePending=false;opened=false;previous=pressed;stopEditing(true);stopTesting();hide();return;}
  if(!opened){opened=true;waitForNeutral=true;direction='';}
  if(capturing){captureSeen=true;previous=pressed;direction='';renderHints();return;}
  if(captureSeen){captureSeen=false;waitForNeutral=true;}
  if(waitForNeutral){previous=pressed;if(neutral(pad))waitForNeutral=false;renderHints();return;}
  if(testing&&!eligible(testing))stopTesting();if(editing&&(active()!==editing.node||!eligible(editing.node)||!options(editing.node).some(o=>o.value===editing.draft)))stopEditing(true);if(editing)positionPicker();
  const edge=i=>pressed.has(i)&&!previous.has(i);
  const x=pad.axes[0]||0,y=pad.axes[1]||0,threshold=direction&&![12,13,14,15].some(i=>previous.has(i)) ? .35 : .6;
  const dir=down(pad,12)?'up':down(pad,13)?'down':down(pad,14)?'left':down(pad,15)?'right':Math.max(Math.abs(x),Math.abs(y))>threshold?(Math.abs(y)>=Math.abs(x)?y>0?'down':'up':x>0?'right':'left'):'';
  if(testing){if(edge(1)){stopTesting();use();}previous=pressed;renderHints();return;}
  if(edge(1)){use();if(editing)stopEditing(true);else back();}
  else if(edge(4)||edge(5)){use();switchTab(edge(4)?-1:1);}
  else if(edge(0)){use();accept();}
  else if(dir&&(dir!==direction||now>=repeatAt)){use();move(dir);repeatAt=now+(dir!==direction?350:130);}
  direction=dir;previous=pressed;
  if(isCapturing())captureSeen=true;
  if(!isOpen()){releasePending=!neutral(pad);opened=false;hide();}
  else renderHints();
 }
 return {update,blocksGameplay:()=>releasePending,
  opened(){const pad=getPad();opened=true;previous=new Set(UI_BUTTONS.filter(i=>down(pad,i)));waitForNeutral=!neutral(pad);direction='';stopEditing(true);stopTesting();hide();},
  resuming(){releasePending=!neutral(getPad());opened=false;stopEditing(true);stopTesting();hide();}};
}
