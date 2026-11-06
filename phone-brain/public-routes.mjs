/** Keep a recently verified secondary during a transient probe failure. Never promote it as online. */
export function savedPublicRoutes(routes,now=Date.now()){
 const anchors=routes.filter(r=>r.stable&&r.persistedVerified&&r.url),seen=new Set();return [...anchors,...routes.filter(r=>r.alive),...routes.filter(r=>!r.alive&&r.processAlive&&r.lastHealthyAt>0&&now-r.lastHealthyAt<=86400000)]
  .filter(r=>{if(!r.url||seen.has(r.url))return false;seen.add(r.url);return true;}).slice(0,2);
}
