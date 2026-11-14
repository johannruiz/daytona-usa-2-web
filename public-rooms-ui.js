// Public directory UI. Room names are text only; no HTML from Firebase is rendered.
const $=id=>document.getElementById(id);
const labels={open:'Open',full:'Full',starting:'Starting',racing:'In race',reconnecting:'Reconnecting'};
export function mountPublicRoomBrowser(directory,{join}={}){
 let latest=directory.snapshot(),busy=false;const rows=new Map();
 function render(state=latest){
  latest=state;const query=$('publicRoomSearch').value.trim().toLocaleLowerCase(),rooms=state.rooms.filter(r=>r.name.toLocaleLowerCase().includes(query));
  const ready=state.status==='ready'&&state.connected,paused=state.status==='paused';
  $('publicRoomCount').textContent=String(state.rooms.length);$('publicListBody').setAttribute('aria-busy',String(state.status==='loading'));
  $('directoryConnection').textContent=paused?'Paused':ready?'● Live':state.status==='error'?'Unavailable':'Connecting…';$('directoryConnection').dataset.state=ready?'ready':state.status;
  for(const [id,row]of rows)if(!rooms.some(r=>r.id===id)){row.li.remove();rows.delete(id);}
  rooms.forEach((room,i)=>{
   let row=rows.get(room.id);if(!row){const li=document.createElement('li'),text=document.createElement('div'),name=document.createElement('strong'),info=document.createElement('div'),count=document.createElement('span'),status=document.createElement('span'),button=document.createElement('button');
    li.className='public-room-row';name.className='public-room-name';info.className='public-room-info';status.className='public-room-state';button.className='ui-button ui-secondary';button.type='button';info.append(count,status);text.append(name,info);li.append(text,button);row={li,name,count,status,button};rows.set(room.id,row);
    button.onclick=async()=>{if(busy||!row.room.joinable||!latest.connected)return;busy=true;render();try{await join(row.room);}finally{busy=false;render();}};
   }
   row.room=room;row.li.dataset.state=room.state;row.name.textContent=room.name;row.name.title=room.name;row.count.textContent=`${room.players} / 16 drivers`;row.status.textContent=room.compatible?labels[room.state]:'Different version';row.button.disabled=busy||!ready||!room.joinable;row.button.textContent=!room.compatible?'UPDATE':room.players>=16?'FULL':['racing','starting'].includes(room.state)?'WAIT FOR NEXT RACE':'JOIN';row.button.setAttribute('aria-label',`Join ${room.name}, ${room.players} of 16 drivers`);
   const list=$('publicRoomsList');if(list.children[i]!==row.li)list.insertBefore(row.li,list.children[i]||null);
  });
  $('directoryEmpty').hidden=rooms.length>0;$('directoryEmptyTitle').textContent=paused?'Room list paused':state.status==='error'?'The room service is unavailable':!ready?'Looking for your grid…':query?'No matching rooms':'The grid is open.';
  $('directoryEmptyText').textContent=paused?'Reconnect when you are ready. Private invitations still work.':state.status==='error'?state.error:!ready?'Connecting to public rooms.':query?'Try a different name.':'Create a public room and let other drivers find you.';
  $('retryPublicRooms').hidden=!paused&&state.status!=='error';$('retryPublicRooms').textContent=paused?'Reconnect':'Retry';$('directoryStatus').textContent=paused?'Paused after 5 minutes without activity.':ready?'Automatic entry · waiting seats available during races':'Private invitations still work.';
  const show=!!directory.desired&&state.hostStatus!=='published';$('roomDirectoryNotice').hidden=!show;$('roomDirectoryMessage').textContent=state.hostStatus==='error'?state.error:'Publishing your public room…';$('retryRoomPublish').hidden=state.hostStatus!=='error';
 }
 directory.changed=render;$('publicRoomSearch').oninput=()=>{directory.interact();render();};$('retryPublicRooms').onclick=$('retryRoomPublish').onclick=()=>directory.retry();
 function visibility(){const yes=document.querySelector('input[name="roomVisibility"]:checked').value==='public';$('createRoomLabel').textContent=yes?'CREATE PUBLIC ROOM':'CREATE PRIVATE ROOM';$('createVisibilityHint').textContent=yes?'Listed publicly · drivers enter automatically.':'Invite only · you approve new drivers.';}
 document.querySelectorAll('input[name="roomVisibility"]').forEach(e=>e.addEventListener('change',visibility));
 let last=0;for(const type of ['pointerdown','keydown','input','change','wheel','focusin','pointermove'])document.addEventListener(type,()=>{if($('multiplayerEntry').hidden)return;if(type==='pointermove'){const n=performance.now();if(n-last<1000)return;last=n;}directory.interact();},{passive:true});
 visibility();render();return {render};
}
