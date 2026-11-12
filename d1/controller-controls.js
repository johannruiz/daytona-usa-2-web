import {CONTROLLER_ACTIONS,ControllerInput,loadControllers,saveControllers,defaultControllerProfile,assignControllerButton,buttonPressed,buttonValue,controllerAcceleration,alternateAccelName,controllerButtonName} from './controller-profile.js?v=53.8.59';
import {gamepadSteering} from './steering.js?v=53.8.59';
const $=(root,id)=>root.querySelector('#'+id);
const clamp=v=>Math.max(-1,Math.min(1,Number.isFinite(v)?v:0));
const setText=(node,value)=>{if(node&&node.textContent!==value)node.textContent=value;};
const svgButton=(i,x,y,label,r=12)=>`<g data-pad-button="${i}"><circle cx="${x}" cy="${y}" r="${r}"/><text x="${x}" y="${y+4}">${label}</text></g>`;
export function createControllerControls(root,{storage,reservedIds=()=>new Set(),wheelPad=()=>null,onChange=()=>{}}){
 const state=loadControllers(storage),input=new ControllerInput();let pads=[],signature='',pending=null,lastUpdate=-Infinity,wasVisible=false;
 const rows=new Map();
 root.innerHTML=`<div class="controller-device-bar"><div><label for="controllerDevice">Active controller</label><select id="controllerDevice" aria-describedby="controllerDeviceStatus"></select></div><span id="controllerDeviceStatus" class="controller-connection" role="status">Connect a controller</span></div>
 <div class="controller-workspace"><section class="controller-preview" tabindex="0" data-gamepad-test aria-label="Controller input test. Press A to test, B to return."><div class="controller-card-heading"><h3>Live input</h3><span id="controllerLayoutType">No device</span></div>
 <svg id="controllerVector" class="controller-vector" viewBox="0 0 420 280" role="img" aria-label="Live controller buttons and sticks">
 <g class="pad-triggers"><g data-pad-button="6"><rect x="94" y="10" width="54" height="24" rx="8"/><text x="121" y="26">LT</text></g><g data-pad-button="7"><rect x="272" y="10" width="54" height="24" rx="8"/><text x="299" y="26">RT</text></g><g data-pad-button="4"><rect x="82" y="43" width="78" height="20" rx="8"/><text x="121" y="57">LB</text></g><g data-pad-button="5"><rect x="260" y="43" width="78" height="20" rx="8"/><text x="299" y="57">RB</text></g></g>
 <path class="pad-body" d="M122 68H298C322 68 338 86 346 111L377 220C384 244 371 263 354 263C343 263 334 257 325 246L287 219Q210 239 133 219L95 246C86 257 77 263 66 263C49 263 36 244 43 220L74 111C82 86 98 68 122 68Z"/>
 <g class="pad-stick" data-pad-button="10"><circle cx="120" cy="122" r="29"/><circle id="controllerLeftStick" class="pad-stick-cap" cx="120" cy="122" r="17"/></g>
 <g class="pad-stick" data-pad-button="11"><circle cx="260" cy="184" r="29"/><circle id="controllerRightStick" class="pad-stick-cap" cx="260" cy="184" r="17"/></g>
 <g class="pad-dpad"><path d="M139 157H157V175H175V193H157V211H139V193H121V175H139Z"/>${[[12,148,166,'↑'],[13,148,202,'↓'],[14,130,184,'←'],[15,166,184,'→']].map(([i,x,y,l])=>`<g data-pad-button="${i}"><circle cx="${x}" cy="${y}" r="8"/><text x="${x}" y="${y+4}">${l}</text></g>`).join('')}</g>
 <g class="pad-face">${[[0,300,148,'A'],[1,325,123,'B'],[2,275,123,'X'],[3,300,98,'Y']].map(args=>svgButton(...args)).join('')}</g>
 <g class="pad-menu">${svgButton(8,190,135,'−',10)}${svgButton(9,230,135,'≡',10)}${svgButton(16,210,96,'⌂',10)}</g></svg>
 <p id="controllerRawButtons" class="controller-input-caption">Press a controller button to make it visible.</p>
 <div class="controller-meters"><label>Steering <output id="controllerSteerValue">0%</output><meter id="controllerSteerMeter" min="-100" max="100" value="0"></meter></label><label>Gas <output id="controllerGasValue">0%</output><meter id="controllerGasMeter" min="0" max="100" value="0"></meter></label><label>Brake <output id="controllerBrakeValue">0%</output><meter id="controllerBrakeMeter" min="0" max="100" value="0"></meter></label></div>
 <p class="controller-preview-note">Press A on Live input to test without moving menu focus; B returns to navigation. Test inputs stay out of the game. Home opens the game menu when the browser exposes it. Alternate throttle defaults to right stick up on standard controllers. Assign another stick direction or an unused button in Buttons. Steering takes priority.</p></section>
 <section class="controller-binding-panel" aria-label="Controller bindings"><div class="controller-edit-tabs" role="tablist" aria-label="Controller settings"><button id="controllerButtonsTab" type="button" role="tab" aria-controls="controllerButtonsPage" aria-selected="true">Buttons</button><button id="controllerFeelTab" type="button" role="tab" aria-controls="controllerFeelPage" aria-selected="false" tabindex="-1">Steering &amp; feedback</button></div><div id="controllerButtonsPage" role="tabpanel" aria-labelledby="controllerButtonsTab"><div class="controller-card-heading"><h3>Button mapping</h3><button id="controllerReset" type="button" class="controller-reset">Restore defaults</button></div><div id="controllerMappings" class="controller-mapping-grid"></div><div class="controller-assignment-status"><p id="controllerAssignmentStatus" role="status">Choose an action, then press its new button. Existing assignments swap automatically.</p><button id="controllerCancel" type="button" hidden>Cancel</button></div></div><div id="controllerFeelPage" role="tabpanel" aria-labelledby="controllerFeelTab" hidden></div></section></div>`;
 $(root,'controllerFeelPage').append(document.getElementById('controllerFeelContent'));document.getElementById('controllerFeelContent').hidden=false;
 const select=$(root,'controllerDevice'),status=$(root,'controllerDeviceStatus'),axis=document.getElementById('controllerSteeringAxis'),invert=document.getElementById('controllerSteeringInvert');
 const available=()=>{const reserved=reservedIds();return pads.filter(p=>p?.connected&&(!reserved.has(p.id)||state.selected?.id===p.id));};
 function getPad(){const all=available();return (state.selected?all.find(p=>p.id===state.selected.id&&p.index===state.selected.index):all.find(p=>p.mapping==='standard')||all[0])||null;}
 function profile(){const pad=getPad();if(!pad)return null;if(!state.profiles.has(pad.id))state.profiles.set(pad.id,defaultControllerProfile());return state.profiles.get(pad.id);}
 const actionLabel=action=>action==='alternateAccel'?'Alternate throttle':CONTROLLER_ACTIONS[action];
 const announce=text=>{$(root,'controllerAssignmentStatus').textContent=text;};
 function persist(){saveControllers(storage,state);input.reset();onChange();}
 function cancel(message='Assignment cancelled. Your mapping is unchanged.'){if(!pending)return false;const action=pending.action;pending=null;rows.get(action).classList.remove('is-listening');$(root,'controllerCancel').hidden=true;renderBindings();announce(message);return true;}
 function learn(action){
  cancel();const pad=getPad();if(!pad)return;pending={action,key:`${pad.index}:${pad.id}`,started:performance.now(),axesReady:new Set(pad.axes.map((v,i)=>Math.abs(v)<.2?i:-1).filter(i=>i>=0)),previous:new Set(pad.buttons.map((_,i)=>i).filter(i=>buttonPressed(pad,i)))};
  rows.get(action).classList.add('is-listening');rows.get(action).textContent=action==='alternateAccel'?'Move stick / press…':'Press a button…';$(root,'controllerCancel').hidden=false;announce(`Assign ${actionLabel(action)}. ${action==='alternateAccel'?'Centre the stick, then move it or press an unused button.':'Release held buttons, then press one.'} Esc cancels.`);
 }
 for(const action of ['gear1','gear2','gear3','gear4','shiftDown','shiftUp','accel','alternateAccel','brake','camera1','camera2','camera3','camera4','coin','start']){
  const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');row.className='controller-map-row';label.textContent=actionLabel(action);button.type='button';button.dataset.action=action;button.setAttribute('aria-label',`Reassign ${actionLabel(action)}`);button.addEventListener('click',()=>learn(action));row.append(label,button);$(root,'controllerMappings').append(row);rows.set(action,button);
 }
 function updateGuide(){const pad=getPad(),p=profile()||state.profiles.get(state.selected?.id)||defaultControllerProfile(),name=action=>controllerButtonName(p.buttons[action],!pad||pad.mapping==='standard',pad?.id);
  const values={guideGamepadSteer:(!pad||pad.mapping==='standard'?['Left stick X','Left stick Y','Right stick X','Right stick Y'][p.steeringAxis]:null)||`Axis ${p.steeringAxis}`,guideGamepadPedals:`${name('accel')} / ${name('brake')}`,guideGamepadGears:`${[1,2,3,4].map(i=>name('gear'+i)).join(' ')} / ${name('shiftDown')} ${name('shiftUp')}`,guideGamepadViews:`${name('coin')} / ${name('start')} / ${[1,2,3,4].map(i=>name('camera'+i).replace('D-pad ', '')).join(' ')}`};
  for(const [id,value] of Object.entries(values)){const node=document.getElementById(id);if(node)node.textContent=value;}
 }
 function renderBindings(){updateGuide();const pad=getPad(),p=profile();for(const [action,button] of rows){button.disabled=!pad;button.textContent=p?(action==='alternateAccel'?alternateAccelName(p.alternateAccel,pad):controllerButtonName(p.buttons[action],pad.mapping==='standard',pad.id)):'—';button.title=p?(action==='alternateAccel'?'Assign a stick direction or an unused button':`Button ${p.buttons[action]} · click to reassign`):'';button.classList.remove('is-listening');}$(root,'controllerReset').disabled=!pad;}
 function renderDevices(){
  select.replaceChildren();const automatic=document.createElement('option');automatic.value='auto';automatic.textContent='Automatic · first available controller';select.append(automatic);
  for(const pad of available()){const option=document.createElement('option');option.value=String(pad.index);option.textContent=`${pad.index+1} · ${pad.id}`;select.append(option);}
  const pad=getPad();automatic.textContent=pad?`Automatic · ${pad.id}`:'Automatic · first available controller';if(state.selected&&!pad){const option=document.createElement('option');option.value='missing';option.textContent=`${state.selected.id} · disconnected`;option.disabled=true;select.append(option);}
  select.value=state.selected?(pad?String(pad.index):'missing'):'auto';select.title=pad?.id||'Press a controller button to allow browser detection.';
  const p=profile();axis.replaceChildren();for(let i=0;i<Math.max(pad?.axes.length||0,(p?.steeringAxis??0)+1);i++){const option=document.createElement('option');option.value=String(i);option.textContent=pad?.mapping==='standard'?['Left stick · horizontal','Left stick · vertical','Right stick · horizontal','Right stick · vertical'][i]||`Axis ${i}`:`Axis ${i}`;axis.append(option);}axis.disabled=!pad;axis.value=String(p?.steeringAxis??0);invert.checked=p?.invert??false;invert.disabled=!pad;
  status.textContent=pad?`Connected · device ${pad.index+1}`:state.selected?'Selected device disconnected':'Press a button to connect';status.dataset.connected=String(!!pad);$(root,'controllerLayoutType').textContent=pad?.mapping==='standard'?'Standard layout':pad?'Generic · positions may differ':'No device';for(const node of svgNodes){const index=Number(node.dataset.padButton),text=node.querySelector('text');if(!text)continue;if(!node.dataset.defaultLabel)node.dataset.defaultLabel=text.textContent;text.textContent=pad?(pad.mapping!=='standard'?String(index):index<8?controllerButtonName(index,true,pad.id):node.dataset.defaultLabel):node.dataset.defaultLabel;}renderBindings();
 }
 select.addEventListener('change',()=>{cancel();const pad=available().find(p=>String(p.index)===select.value);state.selected=pad?{id:pad.id,index:pad.index}:null;persist();renderDevices();announce('Controller selected. Saved mappings are loaded for this model.');});
 axis.addEventListener('change',()=>{const p=profile();if(p){p.steeringAxis=Number(axis.value);persist();updateGuide();}});invert.addEventListener('change',()=>{const p=profile();if(p){p.invert=invert.checked;persist();}});
 $(root,'controllerCancel').onclick=()=>cancel();$(root,'controllerReset').onclick=()=>{const pad=getPad();if(!pad)return;cancel();state.profiles.set(pad.id,defaultControllerProfile());persist();renderDevices();announce('Default mapping restored for this controller.');};
 const tabs=[$(root,'controllerButtonsTab'),$(root,'controllerFeelTab')];
 function selectTab(tab,focus=false){cancel();for(const item of tabs){const on=item===tab;item.setAttribute('aria-selected',String(on));item.tabIndex=on?0:-1;$(root,item.getAttribute('aria-controls')).hidden=!on;}if(focus)tab.focus();}
 for(const tab of tabs){tab.onclick=()=>selectTab(tab);tab.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();selectTab(e.key==='Home'?tabs[0]:e.key==='End'?tabs[1]:tabs[1-tabs.indexOf(tab)],true);}});}
 const svgNodes=[...root.querySelectorAll('[data-pad-button]')];
 function update(nextPads,now,visible,sensitivity=1,deadzone=.08){
  pads=nextPads;
  if(!visible&&pending)cancel();
  if(!visible&&now-lastUpdate<250)return;if(visible&&wasVisible&&now-lastUpdate<40)return;lastUpdate=now;wasVisible=visible;
  const nextSignature=available().map(p=>`${p.index}:${p.id}:${p.mapping}:${p.axes.length}:${p.buttons.length}`).join('|');if(nextSignature!==signature){signature=nextSignature;if(pending)cancel('Device list changed. Choose an action to try again.');renderDevices();}
  const pad=getPad();if(visible&&!state.selected){const wheel=wheelPad();if(wheel){setText(status,'Wheel profile active · controller on standby');setText(select.options[0],`Automatic · ${wheel.id}`);status.title='Turn off Enable wheel in gameplay to drive with a controller.';}else{setText(status,pad?`Connected · device ${pad.index+1}`:'Press a button to connect');status.title=pad?.id||'';setText(select.options[0],pad?`Automatic · ${pad.id}`:'Automatic · first available controller');}}if(pending){
   if(!pad||pending.key!==`${pad.index}:${pad.id}`)cancel('Controller disconnected. Your mapping is unchanged.');
   else if(now-pending.started>12000)cancel('No button detected. Choose an action to try again.');
   else if(pending.action==='alternateAccel'){
    for(let i=0;i<pad.axes.length;i++)if(Math.abs(pad.axes[i])<.2)pending.axesReady.add(i);
    const axis=pad.axes.findIndex((v,i)=>pending.axesReady.has(i)&&Math.abs(v)>.6);
    const next=new Set(pad.buttons.map((_,i)=>i).filter(i=>buttonPressed(pad,i))),button=[...next].find(i=>!pending.previous.has(i));pending.previous=next;
    if(axis>=0||button!==undefined){
     const p=profile();
     if(axis===p.steeringAxis){pending.axesReady.delete(axis);announce('This axis is used for steering. Choose another direction or an unused button.');}
     else if(button!==undefined&&Object.values(p.buttons).includes(button)){announce('This button already has an action. Choose an unused button or a stick direction.');}
     else{p.alternateAccel=axis>=0?{axis,direction:Math.sign(pad.axes[axis]),standardOnly:false}:{button};cancel('');persist();renderBindings();announce('Alternate throttle → '+alternateAccelName(p.alternateAccel,pad)+'.');rows.get('alternateAccel').focus();}
    }
   }
   else {const next=new Set(pad.buttons.map((_,i)=>i).filter(i=>buttonPressed(pad,i))),index=[...next].find(i=>!pending.previous.has(i));if(index!==undefined){const action=pending.action,p=profile(),other=assignControllerButton(p,action,index);cancel('');persist();renderBindings();announce(`${CONTROLLER_ACTIONS[action]} → ${controllerButtonName(index,pad.mapping==='standard',pad.id)}.${other?' Swapped with '+CONTROLLER_ACTIONS[other]+'.':''}`);rows.get(action).focus();}else pending.previous=next;}
  }
  if(!visible)return;
  for(const node of svgNodes){const index=Number(node.dataset.padButton),value=buttonValue(pad,index);node.classList.toggle('pressed',buttonPressed(pad,index));node.style.setProperty('--pressure',String(value));}
  for(const [id,offset] of [['controllerLeftStick',0],['controllerRightStick',2]])$(root,id).setAttribute('transform',`translate(${clamp(pad?.axes[offset])*11} ${clamp(pad?.axes[offset+1])*11})`);
  const p=profile(),raw=pad&&p?{steer:gamepadSteering((pad.axes[p.steeringAxis]||0)*(p.invert?-1:1),sensitivity,deadzone),accel:controllerAcceleration(pad,p),brake:Math.round(buttonValue(pad,p.buttons.brake)*100)}:{steer:0,accel:0,brake:0};
  for(const [name,key] of [['Steer','steer'],['Gas','accel'],['Brake','brake']]){$(root,'controller'+name+'Value').textContent=raw[key]+'%';$(root,'controller'+name+'Meter').value=raw[key];}
  const down=pad?pad.buttons.map((_,i)=>i).filter(i=>buttonPressed(pad,i)):[];const caption=pad?down.length?'Pressed · '+down.map(i=>controllerButtonName(i,pad.mapping==='standard',pad.id)).join(' + '):'Move the sticks or press a button to test.':'Press a controller button to make it visible.';if($(root,'controllerRawButtons').textContent!==caption)$(root,'controllerRawButtons').textContent=caption;
 }
 renderDevices();
 return {update,getPad,hasExplicitSelection:()=>!!state.selected,read:(sensitivity,deadzone)=>input.read(getPad(),profile(),sensitivity,deadzone),cancel,resetEdges:()=>input.reset(),profile,selectDevice(index){select.value=String(index);select.dispatchEvent(new Event('change'));},isListening:()=>!!pending};
}

