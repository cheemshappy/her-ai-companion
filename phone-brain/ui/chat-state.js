/* A shared daily conversation follows the server clock across local/tunnel origins. */
(function(){
 const calendar=window.HerCalendar;let offset=0,key=calendar.day(),ready;
 function update(){const next=calendar.day(Date.now()+offset);if(next!==key){const previous=key;key=next;window.dispatchEvent(new CustomEvent('her:day',{detail:{day:key,previous}}));}return key;}
 async function sync(){try{const response=await fetch('/api/chat/state',{cache:'no-store',signal:AbortSignal.timeout(6000)});if(!response.ok)return null;const value=await response.json();if(value.ok&&Number.isFinite(value.now)){offset=value.now-Date.now();update();}return value;}catch{return null;}}
 window.HerChat={get day(){return update();},get sessionId(){return 'phone:'+update();},get ready(){return ready;},sync};
 ready=sync();setInterval(()=>void sync(),60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync();});
})();
