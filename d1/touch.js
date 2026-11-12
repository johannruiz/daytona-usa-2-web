import {bindTouchActivation} from './touch-guard.js?v=53.8.59';
// Timed by genuine simulation steps; menus and monitor refresh cannot restart it.
export class StartThrottleWindow{
 constructor(){this.elapsed=0;this.scene=0;}
 update(scene,seconds){
  if(scene===20||scene===21)this.elapsed=0;
  else if(scene===22)this.elapsed=Math.min(5,this.elapsed+Math.max(0,Math.min(.05,Number.isFinite(seconds)?seconds:0)));
  else this.elapsed=0;
  this.scene=scene;return (scene===20||scene===21)||(scene===22&&this.elapsed<5-1e-9);
 }
}
// Independent pointer IDs allow steering and pedals to be held together.
export function createTouchControls(root, {isRunning, shift, menu, settings, sound}) {
  const pointers=new Map();
  let steeringPointer=null, steering=0, camera=0,throttlePointer=null,throttle=0,launchEnabled=false,lastThrottle=-1;
  const launchWindow=new StartThrottleWindow(),launch=root.querySelector('[data-launch-throttle]'),launchTrack=launch?.querySelector('.launch-throttle-track'),launchValue=launch?.querySelector('output');
  function paintThrottle(){if(!launch||lastThrottle===throttle)return;lastThrottle=throttle;launch.style.setProperty('--launch-level',String(throttle));launch.setAttribute('aria-valuenow',String(throttle));launchValue.textContent=throttle+'%';}
  function showLaunch(){const hidden=!launchEnabled&&throttlePointer===null;if(launch&&launch.hidden!==hidden)launch.hidden=hidden;}
  function throttleMove(e){const b=launchTrack.getBoundingClientRect();throttle=Math.round(Math.max(0,Math.min(100,(b.bottom-e.clientY)/Math.max(1,b.height)*100)));paintThrottle();}
  const pad=root.querySelector('[data-steering]');
  const knob=root.querySelector('.steering-knob');
  function move(e){
    const box=pad.getBoundingClientRect();
    const travel=Math.max(1,box.width/2-knob.getBoundingClientRect().width/2-14);
    const value=Math.max(-1,Math.min(1,(e.clientX-box.left-box.width/2)/travel));
    steering=Math.abs(value)<.08?0:Math.round(value*100);
    knob.style.transform=`translateX(${steering/100*travel}px)`;
  }
  function release(e){
    const action=pointers.get(e.pointerId);pointers.delete(e.pointerId);
    if(e.pointerId===throttlePointer){throttlePointer=null;throttle=0;paintThrottle();showLaunch();}
    if(e.pointerId===steeringPointer){steeringPointer=null;steering=0;knob.style.transform='';}
    if(action && ![...pointers.values()].includes(action))root.querySelector(`[data-action="${action}"]`)?.classList.remove('pressed');
  }
  launch?.addEventListener('pointerdown',e=>{
    if(!isRunning()||!launchEnabled||throttlePointer!==null)return;
    e.preventDefault();throttlePointer=e.pointerId;launch.setPointerCapture(e.pointerId);throttleMove(e);
  });
  launch?.addEventListener('pointermove',e=>{if(e.pointerId===throttlePointer)throttleMove(e);});
  launch?.addEventListener('keydown',e=>{
    if(!isRunning()||!launchEnabled)return;
    const delta={ArrowUp:5,ArrowRight:5,ArrowDown:-5,ArrowLeft:-5}[e.code];
    if(delta!==undefined){e.preventDefault();e.stopPropagation();throttle=Math.max(0,Math.min(100,throttle+delta));paintThrottle();}
  });
  launch?.addEventListener('blur',()=>{if(throttlePointer===null){throttle=0;paintThrottle();}});
  pad.addEventListener('pointerdown',e=>{
    if(!isRunning() || steeringPointer!==null)return;
    e.preventDefault();steeringPointer=e.pointerId;pad.setPointerCapture(e.pointerId);move(e);
  });
  pad.addEventListener('pointermove',e=>{if(e.pointerId===steeringPointer)move(e);});
  for(const button of root.querySelectorAll('[data-action]')){
    button.addEventListener('pointerdown',e=>{
      if(!isRunning())return;
      e.preventDefault();button.setPointerCapture(e.pointerId);
      const action=button.dataset.action;pointers.set(e.pointerId,action);button.classList.add('pressed');
      if(action==='up')shift(1);
      if(action==='down')shift(-1);
      if(action==='camera')camera=(camera+1)%4;
    });
  }
  for(const name of ['pointerup','pointercancel','lostpointercapture'])root.addEventListener(name,release);
  bindTouchActivation(root.querySelector('[data-menu]'),menu);
  bindTouchActivation(root.querySelector('[data-settings]'),settings);
  bindTouchActivation(root.querySelector('[data-sound]'),sound);
  const clear=()=>{pointers.clear();steeringPointer=null;steering=0;throttlePointer=null;throttle=0;paintThrottle();showLaunch();knob.style.transform='';root.querySelectorAll('.pressed').forEach(b=>b.classList.remove('pressed'));};
  window.addEventListener('blur',clear);
  window.addEventListener('resize',clear);
  return {clear,updateLaunch(scene,seconds){launchEnabled=launchWindow.update(scene,seconds);if(![20,21,22].includes(scene)){throttlePointer=null;throttle=0;paintThrottle();}else if(!launchEnabled&&throttlePointer===null&&throttle){throttle=0;paintThrottle();}showLaunch();},read(){
    const actions=new Set(pointers.values());
    let buttons=0;
    if(actions.has('coin'))buttons|=1;
    if(actions.has('start'))buttons|=2;
    if(actions.has('camera'))buttons|=1<<(4+camera);
    if(actions.has('test'))buttons|=4;
    if(actions.has('service'))buttons|=8;
    if(actions.has('previous'))buttons|=128;
    if(actions.has('next'))buttons|=32;
    if(actions.has('value'))buttons|=64;
    return {steer:steering,accel:Math.max(actions.has('gas')?100:0,throttle),brake:actions.has('brake')?100:0,buttons};
  }};
}
