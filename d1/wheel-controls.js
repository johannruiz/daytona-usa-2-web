// Detection/reset improvements adapted from gareth10203, PR #2.
import {WHEEL_ACTIONS,newWheelProfile,loadWheelProfiles,saveWheelProfiles,sanitizeBinding,bindingDevice,rawInput,
  steeringCalibrated,pedalCalibrated,wheelSteering,wheelPedal,readWheel,snapshotDevices,detectBinding,bindingPressed} from './wheel.js?v=53.8.59';

export function createWheelControls(root,{storage,getPads,onChange=()=>{},onDevice=()=>{},onReset=()=>{},deviceActions=[],hardware=null}) {
  const saved=loadWheelProfiles(storage),rows=new Map();
  let pads=[],pending=null,lastUpdate=-Infinity,signature='',edges={armed:false,previous:new Set()};
  const profile=()=>saved.profiles.find(item=>item.deviceId===saved.selectedId) || null;
  const create=(tag,text='',className='')=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
  const announce=text=>{if(message.textContent!==text)message.textContent=text;};
  const bindingLabel=binding=>binding?`${binding.deviceId.slice(0,32)} [${bindingDevice(binding,pads)?.index ?? binding.deviceIndex}] · ${binding.type==='button'?'Button': 'Axis'} ${binding.index}${binding.type==='axis-button'?` at ${binding.target.toFixed(2)}`:''}`:'Not assigned';
  const bindingKey=binding=>JSON.stringify({deviceId:binding.deviceId,deviceIndex:binding.deviceIndex,type:binding.type,index:binding.index,...(binding.type==='axis-button'?{target:binding.target,neutral:binding.neutral}:{})});
  const persist=()=>{saveWheelProfiles(storage,saved);edges={armed:false,previous:new Set()};onChange();};
  function details(title,open=false){const node=create('details','','wheel-section');node.open=open;node.append(create('summary',title));root.append(node);return node;}
  const connection=create('div','','wheel-connection');
  const deviceLabel=create('label','Wheel device');deviceLabel.htmlFor='wheelDevice';
  const device=create('select');device.id='wheelDevice';
  const deviceRow=create('div','','wheel-device-row'),detectDevice=create('button','Detect');detectDevice.type='button';detectDevice.id='wheelDetect';detectDevice.setAttribute('aria-pressed','false');
  const detectionStatus=create('p','','wheel-detection-status');detectionStatus.id='wheelDetectionStatus';detectionStatus.setAttribute('role','status');
  const enabledLabel=create('label','','setting-toggle');
  const enabledText=create('span','Enable wheel in gameplay');enabledText.append(create('small','Turn this on after calibrating steering. Pedals and buttons are optional.'));
  const enabled=create('input');enabled.type='checkbox';enabled.id='wheelEnabled';enabledLabel.append(enabledText,enabled);
  const availability=create('p','','device-status');availability.id='wheelAvailability';availability.setAttribute('role','status');
  deviceRow.append(device,detectDevice,...deviceActions);connection.append(deviceLabel,deviceRow,detectionStatus,enabledLabel,availability);root.append(connection);if(hardware)root.append(hardware);
  const learnBar=create('div','','wheel-learn-bar'),message=create('p','Choose your wheel. Click Detect input, then move the control you want to use.');
  message.id='wheelMessage';message.setAttribute('role','status');
  const cancel=create('button','Cancel assignment');cancel.type='button';cancel.id='wheelCancel';cancel.hidden=true;
  learnBar.append(message,cancel);root.append(learnBar);
  const preview=create('div','','wheel-preview');preview.setAttribute('aria-label','Live calibrated wheel inputs');
  const meters={};
  for(const [role,label] of [['steering','Steering'],['accel','Accelerator'],['brake','Brake']]){
    const item=create('div'),name=create('span',label),value=create('output','0%'),meter=create('meter');
    meter.min=role==='steering'?-100:0;meter.max=100;meter.value=0;meter.setAttribute('aria-label',label);
    value.id=`wheel-${role}-value`;item.append(name,value,meter);preview.append(item);meters[role]={meter,value};
  }
  root.append(preview);
  function selectDevice(id){
    cancelAssignment();saved.selectedId=id;
    const pad=pads.find(item=>item.id===id);
    if(pad && !profile()){
      if(saved.profiles.length>=24)saved.profiles.shift();
      saved.profiles.push(newWheelProfile(pad.id,pad.index));
    }
    if(pad && profile())profile().deviceIndex=pad.index;
    persist();render();announce(profile()?steeringCalibrated(profile().steering)?'Saved calibration loaded. Check the live inputs before playing.':'Click Detect input for steering, turn the wheel, then capture centre, full left and full right.':'Choose a wheel to configure.');
  }
  device.addEventListener('change',()=>{setDeviceDetection('','');selectDevice(device.value);});
  detectDevice.addEventListener('click',()=>{
    if(pending?.role==='device'){cancelAssignment();setDeviceDetection('cancelled','Cancelled');announce('Wheel detection cancelled.');return;}
    pads=getPads().filter(pad=>pad?.connected);pending={role:'device',baseline:snapshotDevices(pads)};cancel.hidden=true;setDeviceDetection('waiting','Move the wheel, press a pedal or press a wheel button.');renderDetection();
    announce('Move the wheel, press a pedal or press a wheel button.');
  });
  enabled.addEventListener('change',()=>{
    const config=profile();if(!config)return;
    const ready=steeringCalibrated(config.steering) && rawInput(config.steering.binding,pads)!==null;
    config.enabled=enabled.checked && ready;persist();render();
    announce(config.enabled?'Wheel input enabled. Keyboard and touch remain available.':'Wheel input disabled. Your mappings are retained.');
  });
  function assign(role,binding){
    const config=profile();if(!config)return;
    if(role in WHEEL_ACTIONS)config.buttons[role]=binding;
    else {
      config[role].binding=binding;
      for(const key of role==='steering'?['center','left','right']:['rest','full'])config[role][key]=null;
    }
    persist();render();
  }
  function renderDetection(){
    const detectingDevice=pending?.role==='device';detectDevice.classList.toggle('detecting',detectingDevice);detectDevice.setAttribute('aria-pressed',String(detectingDevice));
    detectDevice.textContent=detectingDevice?'Cancel':'Detect';
    for(const [role,row] of rows){
      const active=pending?.role===role;
      row.learn.classList.toggle('detecting',active);
      row.learn.setAttribute('aria-pressed',String(active));
    }
  }
  function setDeviceDetection(state,text){
    detectionStatus.textContent=text;
    for(const name of ['waiting','detected','cancelled'])detectionStatus.classList.toggle(`is-${name}`,state===name);
  }
  function cancelAssignment(){pending=null;cancel.hidden=true;renderDetection();}
  cancel.addEventListener('click',()=>{cancelAssignment();announce('Assignment cancelled. Existing mapping retained.');});
  root.addEventListener('keydown',event=>{
    if(event.code==='Escape' && pending){event.preventDefault();event.stopPropagation();const detectingDevice=pending.role==='device';cancelAssignment();if(detectingDevice)setDeviceDetection('cancelled','Cancelled');announce(detectingDevice?'Wheel detection cancelled.':'Assignment cancelled.');}
  });
  function listen(role){
    if(!profile())return;
    pads=getPads();pending={role,baseline:snapshotDevices(pads)};cancel.hidden=false;renderDetection();
    announce(role==='steering'?'Turn the wheel noticeably. Keep other controls still.':role in WHEEL_ACTIONS?`Press the control for ${WHEEL_ACTIONS[role]}. Esc cancels.`:`Press the ${role==='accel'?'accelerator':'brake'} pedal. Keep other controls still.`);
  }
  function mappingRow(role,label,parent){
    const node=create('div','','wheel-mapping-row'),title=create('label',label),select=create('select'),learn=create('button','Detect input');
    select.id=`wheel-${role}-binding`;title.htmlFor=select.id;learn.type='button';learn.id=`wheel-${role}-learn`;
    learn.setAttribute('aria-label',`Detect ${label.toLowerCase()} from device input`);
    learn.setAttribute('aria-pressed','false');
    learn.addEventListener('click',()=>listen(role));
    select.addEventListener('change',()=>{
      cancelAssignment();let binding=null;try{binding=sanitizeBinding(JSON.parse(select.value));}catch{}
      assign(role,binding);announce(binding?`${label} assigned. ${role in WHEEL_ACTIONS?'Check its live indicator.':'Capture its calibration positions below.'}`:`${label} cleared.`);
    });
    const indicator=create('span','','wheel-button-state');indicator.setAttribute('aria-hidden','true');
    node.append(title,select,learn);if(role in WHEEL_ACTIONS)node.append(indicator);
    parent.append(node);rows.set(role,{select,learn,indicator});return node;
  }
  const captureButtons=[];
  function calibration(role,parent){
    const group=create('div','','wheel-calibration'),captions=role==='steering'?[['center','Centre'],['left','Full left'],['right','Full right']]:[['rest','Released'],['full','Fully pressed']];
    for(const [key,label] of captions){
      const item=create('div'),button=create('button',`Capture ${label.toLowerCase()}`),value=create('output','Not captured');
      button.type='button';button.id=`wheel-${role}-${key}`;value.id=`wheel-${role}-${key}-value`;
      button.addEventListener('click',()=>{
        const config=profile(),sample=rawInput(config?.[role]?.binding,getPads());
        if(sample===null){announce('Assigned device is unavailable. Connect it and try again.');return;}
        config[role][key]=sample;persist();render();
        const ready=role==='steering'?steeringCalibrated(config[role]):pedalCalibrated(config[role]);
        const allSteering=role==='steering'&&['center','left','right'].every(name=>Number.isFinite(config[role][name]));
        announce(`${label} captured.${ready?(role==='steering'?' Calibration complete. Turn on Enable wheel in gameplay above.':' Calibration complete.'):allSteering?' Calibration invalid: centre must be between full left and full right. Recapture the three positions.':role==='steering'?' Capture the other positions; left and right must be on opposite sides of centre.':' Capture both released and fully pressed positions.'}`);
      });
      item.append(button,value);group.append(item);captureButtons.push({role,key,button,value});
    }
    parent.append(group);
  }
  const steering=details('Steering',true);mappingRow('steering','Steering input',steering);calibration('steering',steering);
  const reverseLabel=create('label','','wheel-reverse'),reverse=create('input');reverse.type='checkbox';reverse.id='wheelReverse';reverseLabel.append(reverse,document.createTextNode(' Reverse steering direction'));steering.append(reverseLabel);
  reverse.addEventListener('change',()=>{if(profile()){profile().steering.invert=reverse.checked;persist();render();}});
  function slider(id,label,min,max,initial,help,update){
    const row=create('div','','setting-slider'),head=create('div'),title=create('label',label),value=create('output',`${initial}%`),input=create('input');
    input.id=id;input.type='range';input.min=min;input.max=max;input.step=1;input.value=initial;title.htmlFor=id;value.htmlFor=id;
    head.append(title,value);row.append(head,input,create('p',help));steering.append(row);
    input.addEventListener('input',()=>{if(profile()){update(profile(),Number(input.value)/100);persist();value.textContent=`${input.value}%`;}});
    return {input,value};
  }
  const deadzone=slider('wheelDeadzone','Wheel dead zone',0,15,2,'Filters small movements around the captured centre.',(config,value)=>config.steering.deadzone=value);
  const sensitivity=slider('wheelSensitivity','Wheel response',25,175,100,'100% is linear across your calibrated steering range.',(config,value)=>config.steering.sensitivity=value);
  const pedals=details('Pedals');pedals.append(create('p','Click Detect input, then press one pedal. Capture it released and fully pressed. Combined pedals may share an axis; reversed axes are handled automatically.','wheel-help'));
  for(const [role,label] of [['accel','Accelerator'],['brake','Brake']]){
    const group=create('div','','wheel-pedal');mappingRow(role,label,group);calibration(role,group);pedals.append(group);
  }
  const buttons=details('Gears & buttons'),buttonGrid=create('div','','wheel-button-grid');
  buttons.append(create('p','Release controls before clicking Detect input, then press one button or hat direction. Use gear positions, paddles, or both.','wheel-help'),buttonGrid);
  for(const [action,label] of Object.entries(WHEEL_ACTIONS))mappingRow(action,label,buttonGrid);
  const inspector=details('Live device inputs'),raw=create('pre');raw.id='wheelRawInputs';inspector.append(raw);
  const reset=create('button','Reset this wheel profile');reset.type='button';reset.id='wheelReset';reset.className='wheel-reset';root.append(reset);
  reset.addEventListener('click',()=>{
    const config=profile();if(!config)return;
    cancelAssignment();setDeviceDetection('','');saved.profiles.splice(saved.profiles.indexOf(config),1);saved.selectedId='';
    persist();render();onReset();announce('Wheel profile, device selection and force feedback cleared.');
  });
  function addOption(select,text,value){const option=create('option',text);option.value=value;select.append(option);}
  function renderOptions(){
    device.replaceChildren();addOption(device,pads.length?'Choose a wheel…':'No devices detected','');
    const ids=new Set();
    for(const pad of pads){if(ids.has(pad.id))continue;ids.add(pad.id);addOption(device,pad.id,pad.id);}
    if(saved.selectedId && !ids.has(saved.selectedId))addOption(device,`${saved.selectedId} (disconnected)`,saved.selectedId);
    device.value=saved.selectedId;
    for(const [role,row] of rows){
      row.select.replaceChildren();addOption(row.select,'Not assigned','');
      for(const pad of pads){
        const short=`${pad.id.length>32?`${pad.id.slice(0,32)}…`:pad.id} [${pad.index}]`;
        const binding=(type,index,extra={})=>bindingKey({deviceId:pad.id,deviceIndex:pad.index,type,index,...extra});
        if(role in WHEEL_ACTIONS){
          for(let index=0;index<pad.buttons.length;index++)addOption(row.select,`${short} · Button ${index}`,binding('button',index));
          for(let index=0;index<pad.axes.length;index++)for(const target of [-1,1]){
            const neutral=pad.axes[index];if(Math.abs(target-neutral)<0.2)continue;
            addOption(row.select,`${short} · Axis ${index} ${target<0?'−':'+'}`,binding('axis-button',index,{target,neutral}));
          }
        }else{
          for(let index=0;index<pad.axes.length;index++)addOption(row.select,`${short} · Axis ${index}`,binding('axis',index));
          if(role!=='steering')for(let index=0;index<pad.buttons.length;index++)addOption(row.select,`${short} · Button ${index}`,binding('button',index));
        }
      }
    }
  }
  function render(){
    renderOptions();const config=profile(),ready=!!config && steeringCalibrated(config.steering) && rawInput(config.steering.binding,pads)!==null;
    enabled.checked=config?.enabled ?? false;enabled.disabled=!config || (!config.enabled && !ready);
    reverse.checked=config?.steering.invert ?? false;reverse.disabled=!config;
    reset.disabled=!config;
    for(const [role,row] of rows){
      const binding=role in WHEEL_ACTIONS?config?.buttons[role]:config?.[role]?.binding,key=binding?bindingKey(binding):'';
      if(binding && ![...row.select.options].some(option=>option.value===key))addOption(row.select,`${bindingLabel(binding)}${bindingDevice(binding,pads)?'':' (disconnected)'}`,key);
      row.select.value=key;row.select.disabled=!config;row.learn.disabled=!config || !pads.length;
      row.select.title=bindingLabel(binding);
    }
    for(const item of captureButtons){
      const value=config?.[item.role]?.[item.key];item.value.textContent=typeof value==='number'?value.toFixed(3):'Not captured';
      item.button.disabled=!config || rawInput(config[item.role].binding,pads)===null;
    }
    deadzone.input.value=Math.round((config?.steering.deadzone ?? 0.02)*100);deadzone.value.textContent=`${deadzone.input.value}%`;deadzone.input.disabled=!config;
    sensitivity.input.value=Math.round((config?.steering.sensitivity ?? 1)*100);sensitivity.value.textContent=`${sensitivity.input.value}%`;sensitivity.input.disabled=!config;
    onDevice(pads.find(item=>item.id===saved.selectedId)||(saved.selectedId?{id:saved.selectedId,index:config?.deviceIndex,connected:false}:null));
  }
  function update(nextPads,now,visible){
    pads=nextPads.filter(pad=>pad?.connected);
    if(!visible && pending)cancelAssignment();
    const nextSignature=pads.map(pad=>`${pad.index}:${pad.id}:${pad.axes.length}:${pad.buttons.length}`).join('|');
    if(nextSignature!==signature){signature=nextSignature;render();}
    if(pending){
      const added=pending.role==='device'&&pads.find(pad=>!pending.baseline.some(sample=>sample.id===pad.id&&sample.index===pad.index));
      const binding=added?{deviceId:added.id,deviceIndex:added.index}:detectBinding(pending.baseline,pads,pending.role);
      if(binding){const role=pending.role;cancelAssignment();if(role==='device'){device.value=binding.deviceId;selectDevice(binding.deviceId);setDeviceDetection('detected','Wheel detected');device.focus();announce('Wheel detected. Map and calibrate its controls below.');}else{assign(role,binding);rows.get(role).select.focus();announce(`${role in WHEEL_ACTIONS?WHEEL_ACTIONS[role]:role==='accel'?'Accelerator':role==='brake'?'Brake':'Steering'} assigned. ${role in WHEEL_ACTIONS?'Check its live indicator.':'Capture the calibration positions below.'}`);}}
      else {
        for(const sample of pending.baseline){
          const pad=pads.find(item=>item.id===sample.id && item.index===sample.index);
          if(pad)for(let index=0;index<sample.buttons.length;index++)if(!pad.buttons[index]?.pressed && (pad.buttons[index]?.value ?? 0)<0.5){sample.buttons[index]=0;sample.pressed[index]=false;}
        }
        for(const sample of snapshotDevices(pads))if(!pending.baseline.some(item=>item.id===sample.id && item.index===sample.index))pending.baseline.push(sample);
      }
    }
    if(now-lastUpdate<100)return;lastUpdate=now;
    const config=profile(),source=config?.steering.binding,connected=rawInput(source,pads)!==null;
    const steeringCaptured=!!config&&['center','left','right'].every(name=>Number.isFinite(config.steering[name]));
    const status=!pads.length?'No devices detected. Press a device button to make it visible.':!config?'Choose the wheel you want to configure.':!connected?'Steering input is unassigned or disconnected.':!steeringCaptured?'Steering calibration incomplete: capture centre, full left and full right. Wheel input is not active.':!steeringCalibrated(config.steering)?'Steering calibration invalid: centre must be between full left and full right. Recapture the three positions.':config.enabled?'Wheel input ready.':'Calibrated. Turn on Enable wheel in gameplay above.';
    if(availability.textContent!==status)availability.textContent=status;
    if(!visible)return;
    const value={steer:wheelSteering(config?.steering,rawInput(config?.steering?.binding,pads)),accel:wheelPedal(config?.accel,rawInput(config?.accel?.binding,pads)),brake:wheelPedal(config?.brake,rawInput(config?.brake?.binding,pads))};
    for(const [role,key] of [['steering','steer'],['accel','accel'],['brake','brake']]){meters[role].meter.value=value[key];meters[role].value.textContent=`${value[key]}%`;}
    for(const [role,row] of rows)if(role in WHEEL_ACTIONS)row.indicator.classList.toggle('active',bindingPressed(config?.buttons[role],pads));
    raw.textContent=pads.map(pad=>`${pad.id} [${pad.index}]\nAxes: ${pad.axes.map((value,index)=>`${index}: ${value.toFixed(3)}`).join('  ')}\nButtons: ${pad.buttons.map((button,index)=>`${index}: ${(button.value ?? 0).toFixed(2)}`).join('  ')}`).join('\n\n') || 'No device inputs available.';
  }
  render();if(profile())announce('Saved wheel profile loaded. Changes save automatically.');
  return {
    update,read:()=>readWheel(profile(),getPads(),edges),
    preview:()=>readWheel(profile(),getPads()),
    resetEdges(){edges={armed:false,previous:new Set()};},
    isListening:()=>!!pending,
    cancel(){const wasPending=!!pending;cancelAssignment();if(wasPending)announce('Assignment cancelled. Existing mapping retained.');},
    reservedIds(){const config=profile();return new Set(config?[config.deviceId,...(config.enabled?[config.steering.binding,config.accel.binding,config.brake.binding,...Object.values(config.buttons)].filter(Boolean).map(binding=>binding.deviceId):[])]:[]);},
    selection(){const config=profile();if(!config)return null;const pads=getPads(),source=config.steering.binding,id=source?.deviceId||config.deviceId,matches=pads.filter(p=>p.connected&&p.id===id),pad=source?bindingDevice(source,pads):matches.length===1?matches[0]:null,calibrated=steeringCalibrated(config.steering);return {id,index:pad?.index,profileId:config.deviceId,name:id,connected:!!pad,calibrated,enabled:!!config.enabled,active:!!config.enabled&&calibrated&&rawInput(source,pads)!==null};},
    feedbackPad(){const config=profile(),pads=getPads();return readWheel(config,pads).active?bindingDevice(config.steering.binding,pads):null;}
  };
}

