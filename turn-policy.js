export function validateIceServers(value) {
 if (!Array.isArray(value) || !value.length || value.length > 8) throw Error('Invalid ICE configuration.');
 const servers=value.map(row=>{
  const urls=Array.isArray(row?.urls)?row.urls:[row?.urls];
  if (!urls.length || urls.some(url=>typeof url!=='string'||!/^(?:stun|turn|turns):(?:stun|turn)\.cloudflare\.com:(?:3478|5349|443|80)(?:\?transport=(?:udp|tcp))?$/.test(url))) throw Error('Invalid relay address.');
  const relay=urls.some(url=>/^turns?:/.test(url));
  if(relay&&[row.username,row.credential].some(x=>typeof x!=='string'||!x||x.length>512))throw Error('Invalid relay credentials.');
  return {urls,...(relay?{username:row.username,credential:row.credential}:{})};
 });
 if(!servers.some(s=>s.credential))throw Error('No TURN relay available.');return servers;
}
