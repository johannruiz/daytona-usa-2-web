// Only the standard mapping defines Home at 16. Never guess for wheels/raw HID.
export function createGamepadHome({getPad,canOpen,open,isFocused=()=>document.hasFocus()&&!document.hidden}){
 let identity='',held=false,armed=false;
 return {update(){
  const pad=getPad(),key=pad?`${pad.index}:${pad.id}`:'';
  const pressed=pad?.mapping==='standard'&&(!!pad.buttons[16]?.pressed||(pad.buttons[16]?.value||0)>.5);
  if(key!==identity||!isFocused()){identity=key;held=pressed;armed=false;return;}
  if(!pressed)armed=true;
  if(pressed&&!held&&armed&&canOpen())open();
  held=pressed;
 }};
}
