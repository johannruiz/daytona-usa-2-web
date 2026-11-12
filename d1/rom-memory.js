// One verified ZIP per installation, stored only in this browser's IndexedDB.
export function romStorageKey(pathname='/'){
 return pathname.replace(/\/index\.html$/i,'/').replace(/\/?$/,'/');
}
export function createROMStore({database,key=romStorageKey(globalThis.location?.pathname),timeoutMs=5000}={}){
 if(database===undefined){try{database=globalThis.indexedDB;}catch{database=null;}}
 function transaction(mode,operation){
  return new Promise((resolve,reject)=>{
   let db,tx,done=false,value;
   const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);db?.close();error?reject(error):resolve(value);};
   const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(Error('Local ROM storage timed out.'));},timeoutMs);
   try{
    if(!database)throw Error('Local ROM storage is unavailable.');
    const open=database.open('daytona-local-rom-v1',1);
    open.onupgradeneeded=()=>{if(!open.result.objectStoreNames.contains('roms'))open.result.createObjectStore('roms');};
    open.onerror=()=>finish(open.error||Error('Could not open local ROM storage.'));
    open.onblocked=()=>finish(Error('Local ROM storage is busy in another tab.'));
    open.onsuccess=()=>{
     db=open.result;if(done){db.close();return;}
     db.onversionchange=()=>db.close();
     try{
      tx=db.transaction('roms',mode);
      tx.oncomplete=()=>finish();tx.onabort=()=>finish(tx.error||Error('Could not update local ROM storage.'));
      const request=operation(tx.objectStore('roms'),key);request.onsuccess=()=>{value=request.result;};
     }catch(error){try{tx?.abort();}catch{}finish(error);}
    };
   }catch(error){finish(error);}
  });
 }
 return {
  read:()=>transaction('readonly',(store,id)=>store.get(id)),
  write:file=>transaction('readwrite',(store,id)=>store.put({version:1,name:file.name,lastModified:file.lastModified||0,blob:file},id)),
  clear:()=>transaction('readwrite',(store,id)=>store.delete(id))
 };
}
function storedFile(record){
 if(record?.version!==1||typeof record.name!=='string'||!/\.zip$/i.test(record.name)||!(record.blob instanceof Blob)||!record.blob.size)return null;
 return new File([record.blob],record.name,{type:'application/zip',lastModified:Number.isFinite(record.lastModified)?record.lastModified:0});
}
export function createROMMemory({store,load,canRestore=()=>true,onBusy=()=>{},onWarning=()=>{}}){
 let generation=0,busy=false;
 async function apply(file,automatic){
  if(busy)return false;
  busy=true;onBusy(true);
  try{
   const result=await load(file,{automatic});
   if(result?.ok&&!automatic){try{await store.write(file);}catch(error){onWarning(error);}}
   if(!result?.ok&&automatic&&result?.invalid){try{await store.clear();}catch(error){onWarning(error);}}
   return !!result?.ok;
  }finally{busy=false;onBusy(false);}
 }
 return {
  async restore(){
   const ticket=generation;if(!canRestore())return false;
   let record;try{record=await store.read();}catch(error){onWarning(error);return false;}
   if(ticket!==generation||!canRestore()||busy)return false;
   if(!record)return false;
   const file=storedFile(record);
   if(!file){try{await store.clear();}catch(error){onWarning(error);}return false;}
   return apply(file,true);
  },
  select(file){++generation;return apply(file,false);}
 };
}
