import {KEYBOARD_ID,KEYBOARD_ACTIONS,DEFAULT_KEYS,loadKeys,assignKey,keyName,validKey,KeyboardInput} from './keyboard-input.js?v=53.8.59';
export function createKeyboardControls(root,{held,storage,settings,mobile,onSetting}){
 const bindings=loadKeys(storage),input=new KeyboardInput(held,bindings),previewHeld=new Set(),preview=new KeyboardInput(previewHeld,bindings),rows=new Map();
 let pending=null,last=0,wasVisible=false,deadline=0;
 const $=id=>root.querySelector('#'+id);
 const slider=(id,label,min,max,value,help)=>`<div class="setting-slider"><div><label for="${id}">${label}</label><output id="${id}Value">${value}%</output></div><input id="${id}" type="range" min="${min}" max="${max}" value="${value}" step="5" aria-describedby="${id}Help"><p id="${id}Help">${help}</p></div>`;
 if(mobile){
  root.innerHTML=`<h2>Your touch cockpit</h2><p class="settings-intro">A little more room to steer. Adjust the controls for your thumbs.</p><div class="touch-settings-grid"><section class="input-preview-card"><h3>Control size preview</h3><div class="touch-size-preview" aria-hidden="true"><div class="preview-touch-pad">‹ <span>↔</span> ›</div><div class="preview-touch-buttons"><span>BRAKE</span><span>GAS</span></div></div><p>Changes apply to the actual controls immediately. The steering pad starts 15% wider.</p></section><section>${slider('touchButtonScale','Button size',85,140,100,'Scales pedals, gear buttons and the top row. Touch targets stay at least 44 px.')}${slider('touchSteeringWidth','Steering pad width',100,165,115,'A wider pad gives you more space for fine steering.')}<button id="touchReset" class="input-reset" type="button">Restore touch defaults</button></section></div>`;
  for(const id of ['touchButtonScale','touchSteeringWidth'])$(id).addEventListener('input',e=>{onSetting(id,Number(e.target.value)/100);sync();});
  $('touchReset').onclick=()=>{onSetting('touchButtonScale',1);onSetting('touchSteeringWidth',1.15);sync();};
 }else{
  root.innerHTML=`<div class="keyboard-workspace"><section class="input-preview-card"><h2>Steering feel</h2><p class="settings-intro">Hold to turn, release to centre. Short taps give you finer control.</p><div id="keyboardTest" class="keyboard-steering-test" tabindex="0" aria-label="Steering test. Hold your assigned left or right key."><svg viewBox="0 0 200 140" role="img" aria-label="Steering direction"><g id="keyboardWheel"><circle cx="100" cy="70" r="51"/><circle cx="100" cy="70" r="14"/><path d="M50 59h36M114 59h36M100 84v36"/><path class="wheel-marker" d="M91 19h18"/></g></svg><div class="steering-test-track"><i></i><span id="keyboardSteerMarker"></span></div><output id="keyboardSteerValue">Centred · 0%</output></div><p class="input-preview-note">Click the wheel and hold your steering keys to test. Test inputs stay out of the game.</p>${slider('keyboardSensitivity','Steering sensitivity',25,175,100,'Lower = slower, finer turns. Higher = quicker steering. Full steering range is always available.')}</section><section class="keyboard-binding-card"><div class="input-card-heading"><h3>Key assignments</h3><button id="keyboardReset" class="input-reset" type="button">Restore defaults</button></div><div id="keyboardMappings" class="keyboard-mappings"></div><div class="keyboard-assignment-status"><p id="keyboardAssignmentStatus" role="status">Select an action and press a key. Occupied keys swap assignments.</p><button id="keyboardCancel" type="button" hidden>Cancel</button></div><p class="keyboard-reserved">Gradual throttle rises and falls over 1.6 seconds. Esc: menu · F2 / F3: original arcade settings.</p></section></div>`;
  for(const [action,label] of Object.entries(KEYBOARD_ACTIONS)){
   const row=document.createElement('div'),text=document.createElement('span'),button=document.createElement('button');row.className='keyboard-map-row';text.textContent=label;button.type='button';button.dataset.keyAction=action;button.setAttribute('aria-label','Reassign '+label);button.onclick=()=>{cancel();pending=action;deadline=performance.now()+12000;previewHeld.clear();preview.reset();button.classList.add('is-listening');button.textContent='Press key…';$('keyboardCancel').hidden=false;$('keyboardAssignmentStatus').textContent=`Press a key for ${label}. Esc cancels; Tab keeps keyboard navigation.`;};row.append(text,button);$('keyboardMappings').append(row);rows.set(action,button);
  }
  $('keyboardCancel').onclick=()=>cancel();$('keyboardReset').onclick=()=>{cancel();Object.assign(bindings,DEFAULT_KEYS);persist();render();$('keyboardAssignmentStatus').textContent='Default keys restored.';};
  $('keyboardSensitivity').addEventListener('input',e=>{onSetting('keyboardSensitivity',Number(e.target.value)/100);sync();});
 }
 function render(){for(const [a,b] of rows){b.textContent=keyName(bindings[a]);b.classList.remove('is-listening');}updateGuide();}
 function updateGuide(){
  for(const [id,actions] of Object.entries({guideKeyboardDriving:['left','right','accel','brake'],guideKeyboardArcade:['coin','start'],guideKeyboardGears:['gear1','gear2','gear3','gear4','shiftDown','shiftUp'],guideKeyboardViews:['camera1','camera2','camera3','camera4']})){
   const node=document.getElementById(id);if(node)node.replaceChildren(...actions.map(a=>{const k=document.createElement('kbd');k.textContent=keyName(bindings[a]);return k;}));
  }
 }
 function persist(){try{storage.setItem(KEYBOARD_ID,JSON.stringify(bindings));}catch{}reset();}
 function cancel(){if(!pending)return false;pending=null;$('keyboardCancel').hidden=true;render();$('keyboardAssignmentStatus').textContent='Assignment cancelled.';return true;}
 function reset(){held.clear();input.reset();previewHeld.clear();preview.reset();}
 function sync(){for(const id of mobile?['touchButtonScale','touchSteeringWidth']:['keyboardSensitivity']){$(id).value=Math.round(settings[id]*100);$(id+'Value').textContent=Math.round(settings[id]*100)+'%';}root.style.setProperty('--touch-button-scale',settings.touchButtonScale);root.style.setProperty('--touch-steering-width',settings.touchSteeringWidth);}
 const shown=()=>!root.closest('[hidden]');
 window.addEventListener('keydown',e=>{
  if(!shown())return;
  if(pending){
   if(e.code==='Tab'){cancel();return;}
   if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();return;}
   e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;
   if(e.ctrlKey||e.metaKey||e.altKey||!validKey(e.code)){$('keyboardAssignmentStatus').textContent='Choose a single key. Esc, Tab, F2/F3 and browser shortcuts stay reserved.';return;}
   const action=pending,other=assignKey(bindings,action,e.code);if(other===false){$('keyboardAssignmentStatus').textContent='Choose an unused key for this unassigned action.';return;}pending=null;$('keyboardCancel').hidden=true;persist();render();$('keyboardAssignmentStatus').textContent=`${KEYBOARD_ACTIONS[action]} → ${keyName(e.code)}.${other?' Swapped with '+KEYBOARD_ACTIONS[other]+'.':''}`;rows.get(action).focus();return;
  }
  if(!mobile&&![bindings.left,bindings.right].includes(e.code))return;
  if(mobile||['INPUT','SELECT','BUTTON'].includes(e.target?.tagName)||e.ctrlKey||e.altKey||e.metaKey)return;
  e.preventDefault();previewHeld.add(e.code);
 },true);
 window.addEventListener('keyup',e=>previewHeld.delete(e.code));window.addEventListener('blur',()=>{cancel();reset();});
 function update(now,visible){
  if(!visible){if(wasVisible){cancel();reset();}wasVisible=false;last=now;return;}
  if(pending&&now>deadline)cancel();const dt=wasVisible?(now-last)/1000:0;wasVisible=true;last=now;
  if(!mobile){const steer=preview.read(dt,settings.keyboardSensitivity).steer;$('keyboardWheel').setAttribute('transform',`rotate(${steer*1.1} 100 70)`);$('keyboardSteerMarker').style.left=`${50+steer*.47}%`;$('keyboardSteerValue').textContent=steer===0?'Centred · 0%':`${steer<0?'Left':'Right'} · ${Math.abs(steer)}%`;}
 }
 sync();render();return {bindings,cancel,reset,update,sync,isListening:()=>!!pending,read:seconds=>input.read(seconds,settings.keyboardSensitivity),action:code=>Object.keys(bindings).find(a=>bindings[a]===code),uses:code=>Object.values(bindings).includes(code)||code==='F2'||code==='F3'};
}
