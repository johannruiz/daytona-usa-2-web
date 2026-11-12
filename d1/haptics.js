// Magnitudes come exclusively from the game's emulated arcade drive board
// (web/native/drive_board_web.c). Daytona USA 2 web (Claude 2026-11-11): no
// centring cue, and impacts start at full strength instead of rising gently.
// Short effects expire if frames stop, even when a browser cannot reset them.
export function createGamepadRumble(onStatus = () => {}) {
  let intensity=1, actuator=null, deviceKey='', failedKey=null;
  let playing=false, lastSent=-Infinity, lastStrong=0, lastWeak=0, epoch=0, status='';
  const report=value=>{if(value!==status){status=value;onStatus(value);}};
  const clamp=value=>Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;
  function stop() {
    epoch++;lastSent=-Infinity;lastStrong=0;lastWeak=0;
    if(playing && actuator) {
      try {
        const result=typeof actuator.reset==='function' ? actuator.reset()
          : actuator.playEffect('dual-rumble',{duration:0,strongMagnitude:0,weakMagnitude:0});
        Promise.resolve(result).catch(()=>{});
      }catch{}
    }
    playing=false;
  }
  function update(pad,strong,weak,now) {
    const key=pad ? `${pad.index}:${pad.id}` : '';
    if(key!==deviceKey){stop();deviceKey=key;actuator=null;failedKey=null;}
    if(!pad){report('Connect a controller');return;}
    const candidate=pad.vibrationActuator;
    if(!candidate || typeof candidate.playEffect!=='function' ||
       (candidate.effects && !candidate.effects.includes('dual-rumble')) || failedKey===key) {
      stop();report('Unavailable on this controller');return;
    }
    actuator=candidate;
    if(intensity===0){stop();report('Off');return;}
    report('Ready');
    strong=clamp(strong)*intensity*0.8;weak=clamp(weak)*intensity*0.8;
    if(strong===0 && weak===0){stop();return;}
    // Refresh at most 20 times/s, including when multiple game frames run;
    // a new impact (a rise) is sent at once.
    if(now-lastSent<50 && strong<=lastStrong && weak<=lastWeak)return;
    lastSent=now;lastStrong=strong;lastWeak=weak;playing=true;
    const token=epoch;
    const fail=()=>{
      if(token!==epoch)return;
      stop();failedKey=key;report('Unavailable on this controller');
    };
    try {
      Promise.resolve(actuator.playEffect('dual-rumble',{
        duration:120,startDelay:0,strongMagnitude:strong,weakMagnitude:weak
      })).catch(fail);
    }catch{fail();}
  }
  return {
    update,stop,
    disconnect(){stop();deviceKey='';actuator=null;failedKey=null;report('Connect a controller');},
    setIntensity(value){
      intensity=clamp(value);stop();
      report(intensity===0?'Off':failedKey?'Unavailable on this controller':actuator?'Ready':'Connect a controller');
    },
    getIntensity(){return intensity;}
  };
}
