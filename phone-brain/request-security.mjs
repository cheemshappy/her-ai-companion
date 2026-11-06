/** Pairing is mandatory even on a fresh installation; no substring cookie matches. */
import crypto from 'node:crypto';
export function sameSecret(value,expected){
 if(typeof value!=='string'||typeof expected!=='string'||!expected)return false;
 const a=Buffer.from(value),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
export function pairingStatus(req,url,token){
 const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean);
 const cookie=cookies.some(x=>{const split=x.indexOf('=');return split>0&&x.slice(0,split)==='amk'&&sameSecret(x.slice(split+1),token);});
 return {cookie,query:sameSecret(url.searchParams.get('k'),token),header:sameSecret(req.headers['x-amadeus-key'],token)};
}
export function trustedBrowserOrigin(req){
 if(!req.headers.origin)return true;
 try{const origin=new URL(req.headers.origin);return ['http:','https:'].includes(origin.protocol)&&origin.host===String(req.headers.host||'');}catch{return false;}
}
export function pairingCookie(req,token){
 const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress),secure=!!req.socket?.encrypted||local&&String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
 return `amk=${token}; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly${secure?'; Secure':''}`;
}
