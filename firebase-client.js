// D2 directory only. No Firebase dependency on game packets, chat or private rooms.
import {FIREBASE_CONFIG} from './firebase-config.js';
const CDN='https://www.gstatic.com/firebasejs/13.0.0/';
let identityPromise;
async function identity(){
 return identityPromise??=(async()=>{
  if(!FIREBASE_CONFIG.apiKey||!FIREBASE_CONFIG.databaseURL)throw Error('Public rooms are not configured.');
  const [appSDK,authSDK]=await Promise.all([import(CDN+'firebase-app.js'),import(CDN+'firebase-auth.js')]);
  const name='daytona2-public-rooms',app=appSDK.getApps().find(a=>a.name===name)||appSDK.initializeApp(FIREBASE_CONFIG,name);
  const auth=authSDK.getAuth(app);await auth.authStateReady();
  if(!auth.currentUser)await authSDK.signInAnonymously(auth);
  return {app,auth};
 })().catch(error=>{identityPromise=null;throw error;});
}
export async function createFirebaseDirectoryBackend(){
 const [{app,auth},sdk]=await Promise.all([identity(),import(CDN+'firebase-database.js')]);
 const db=sdk.getDatabase(app),room=id=>sdk.ref(db,'publicRooms/'+id);
 return {uid:auth.currentUser.uid,timestamp:()=>sdk.serverTimestamp(),online:()=>sdk.goOnline(db),offline:()=>sdk.goOffline(db),
 connection:fn=>sdk.onValue(sdk.ref(db,'.info/connected'),s=>fn(s.val()===true)),
 offset:fn=>sdk.onValue(sdk.ref(db,'.info/serverTimeOffset'),s=>fn(Number(s.val())||0)),
 listen:(next,error)=>sdk.onValue(sdk.query(sdk.ref(db,'publicRooms'),sdk.orderByChild('updatedAt'),sdk.limitToLast(50)),s=>next(s.val()||{}),error),
 arm:id=>sdk.onDisconnect(room(id)).remove(),put:(id,v)=>sdk.set(room(id),v),remove:id=>sdk.remove(room(id)),cancel:id=>sdk.onDisconnect(room(id)).cancel()};
}
