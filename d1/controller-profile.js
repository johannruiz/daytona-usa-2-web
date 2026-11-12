import {gamepadSteering} from './steering.js?v=53.8.59';
export const CONTROLLER_KEY='daytona-controller-profiles-v1';
export const CONTROLLER_ACTIONS=Object.freeze({accel:'Accelerate',brake:'Brake',gear1:'Gear 1',gear2:'Gear 2',gear3:'Gear 3',gear4:'Gear 4',shiftDown:'Shift down',shiftUp:'Shift up',camera1:'Camera 1',camera2:'Camera 2',camera3:'Camera 3',camera4:'Camera 4',coin:'Insert coin',start:'Start'});
export const DEFAULT_BUTTONS=Object.freeze({accel:7,brake:6,gear1:1,gear2:0,gear3:2,gear4:3,shiftDown:4,shiftUp:5,camera1:12,camera2:15,camera3:13,camera4:14,coin:8,start:9});
export function defaultControllerProfile(){return {buttons:{...DEFAULT_BUTTONS},steeringAxis:0,invert:false,alternateAccel:{axis:3,direction:-1,standardOnly:true}};}
const validIndex=n=>Number.isInteger(n)&&n>=0&&n<128;
export function normalizeControllerProfile(source){
 const profile=defaultControllerProfile();
 for(const key of Object.keys(CONTROLLER_ACTIONS))if(source?.buttons?.[key]===null||validIndex(source?.buttons?.[key]))profile.buttons[key]=source.buttons[key];
 if(validIndex(source?.steeringAxis))profile.steeringAxis=source.steeringAxis;
 if(typeof source?.invert==='boolean')profile.invert=source.invert;
 if(source?.alternateAccel===null)profile.alternateAccel=null;
 else if(source?.alternateAccel&&validIndex(source.alternateAccel.button))profile.alternateAccel={button:source.alternateAccel.button};
 else if(source?.alternateAccel&&validIndex(source.alternateAccel.axis)&&[-1,1].includes(source.alternateAccel.direction))profile.alternateAccel={axis:source.alternateAccel.axis,direction:source.alternateAccel.direction,standardOnly:source.alternateAccel.standardOnly===true};
 return profile;
}
export function loadControllers(storage){
 let data;try{data=JSON.parse(storage.getItem(CONTROLLER_KEY));}catch{}
 const profiles=new Map();
 if(Array.isArray(data?.profiles))for(const row of data.profiles.slice(-16))if(typeof row?.id==='string'&&row.id.length<=512)profiles.set(row.id,normalizeControllerProfile(row));
 const selected=typeof data?.selected?.id==='string'&&data.selected.id.length<=512&&validIndex(data.selected.index)?{id:data.selected.id,index:data.selected.index}:null;
 return {selected,profiles};
}
export function saveControllers(storage,state){try{storage.setItem(CONTROLLER_KEY,JSON.stringify({version:1,selected:state.selected,profiles:[...state.profiles].slice(-16).map(([id,p])=>({id,...p}))}));}catch{}}
export const buttonValue=(pad,index)=>index===null?0:Math.max(0,Math.min(1,Number.isFinite(pad?.buttons?.[index]?.value)?pad.buttons[index].value:pad?.buttons?.[index]?.pressed?1:0));
// Learned axes are explicit; only the default right-stick shortcut requires standard mapping.
export function controllerAcceleration(pad,profile){
 const binding=profile.alternateAccel;let alternate=0;
 if(binding?.button!==undefined)alternate=buttonValue(pad,binding.button);
 else if(binding&&(!binding.standardOnly||pad?.mapping==='standard')&&profile.steeringAxis!==binding.axis){
  const raw=pad?.axes?.[binding.axis];
  if(Number.isFinite(raw))alternate=Math.max(0,Math.min(1,(raw*binding.direction-.08)/.92));
 }
 return Math.round(Math.max(buttonValue(pad,profile.buttons.accel),alternate)*100);
}
export function alternateAccelName(binding,pad){
 if(!binding)return 'Not assigned';
 if(binding.button!==undefined)return controllerButtonName(binding.button,pad?.mapping==='standard',pad?.id);
 const name=pad?.mapping==='standard'?['Left stick X','Left stick Y','Right stick X','Right stick Y'][binding.axis]:null;
 return `${name||'Axis '+binding.axis} ${binding.direction<0?'−':'+'}`;
}
export const buttonPressed=(pad,index)=>index!==null&&(!!pad?.buttons?.[index]?.pressed||buttonValue(pad,index)>.5);
export function assignControllerButton(profile,action,index){
 if(!Object.hasOwn(CONTROLLER_ACTIONS,action)||!(index===null||validIndex(index)))return null;
 const old=profile.buttons[action],other=index===null?undefined:Object.keys(CONTROLLER_ACTIONS).find(key=>key!==action&&profile.buttons[key]===index);
 if(index!==null&&profile.alternateAccel?.button===index)profile.alternateAccel=validIndex(old)?{button:old}:null;
 if(other)profile.buttons[other]=old;
 profile.buttons[action]=index;return other||null;
}
export function controllerButtonName(index,standard=true,id=''){
 if(index===null)return 'Not assigned';
 const names=['A','B','X','Y','LB','RB','LT','RT','Back','Start','L stick','R stick','D-pad ↑','D-pad ↓','D-pad ←','D-pad →','Home'];
 if(standard&&/DualSense|DualShock|PlayStation|Sony|054c/i.test(id))return ['×','○','□','△','L1','R1','L2','R2','Share','Options','L3','R3'][index]||names[index]||`Button ${index}`;
 if(standard&&/Nintendo|Switch|Pro Controller/i.test(id))return ['B','A','Y','X','L','R','ZL','ZR','−','+'][index]||names[index]||`Button ${index}`;
 return standard&&names[index]?names[index]:`Button ${index}`;
}
export class ControllerInput {
 constructor(){this.reset();}
 reset(){this.key='';this.previous=new Set();this.blocked=new Set();}
 read(pad,profile,sensitivity=1,deadzone=.08){
  if(!pad){this.reset();return {steer:0,accel:0,brake:0,buttons:0,shift:0,gear:null};}
  const key=`${pad.index}:${pad.id}`,pressed=new Set(pad.buttons.map((_,i)=>i).filter(i=>buttonPressed(pad,i)));
  if(key!==this.key){this.key=key;this.blocked=new Set(pressed);this.previous=new Set();}
  for(const index of this.blocked)if(!pressed.has(index))this.blocked.delete(index);
  const active=action=>pressed.has(profile.buttons[action])&&!this.blocked.has(profile.buttons[action]);
  const shift=Number(active('shiftUp')&&!this.previous.has('shiftUp'))-Number(active('shiftDown')&&!this.previous.has('shiftDown'));
  let gear=null,buttons=0;for(let i=1;i<=4;i++){if(active('gear'+i))gear=i;if(active('camera'+i))buttons|=1<<(3+i);}
  if(active('coin'))buttons|=1;if(active('start'))buttons|=2;
  this.previous=new Set(Object.keys(CONTROLLER_ACTIONS).filter(active));
  return {steer:gamepadSteering((pad.axes[profile.steeringAxis]||0)*(profile.invert?-1:1),sensitivity,deadzone),accel:controllerAcceleration(pad,profile),brake:Math.round(buttonValue(pad,profile.buttons.brake)*100),gear,shift,buttons};
 }
}
