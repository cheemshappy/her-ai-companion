/** Keep classic scripts separate and ordered, but deliver UI code in one complete document. */
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

export function createUiDocuments(directory){
 const root=path.resolve(directory),cache=new Map();
 function localFile(source){
  const url=new URL(source,'http://ui.local');
  if(url.origin!=='http://ui.local')throw Error('UI dependency must be local');
  const file=path.resolve(root,decodeURIComponent(url.pathname).replace(/^\/(?:ui\/)?/,''));
  if(!file.startsWith(root+path.sep))throw Error('UI dependency outside its directory');
  return file;
 }
 return function document(name,{modelInfo}={}){
  const file=localFile('/'+name),html=fs.readFileSync(file,'utf8'),dependencies=[file];
  let expanded=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,(_,source)=>{
   const asset=localFile(source);dependencies.push(asset);
   return '<style data-source="'+new URL(source,'http://ui.local').pathname+'">'+fs.readFileSync(asset,'utf8').replace(/<\/style/gi,'<\\/style')+'</style>';
  }).replace(/<script\s+src="([^"]+)"\s*><\/script>/g,(_,source)=>{
   const asset=localFile(source);dependencies.push(asset);
   // A separate script element preserves classic-script scope and execution timing.
   return '<script data-source="'+new URL(source,'http://ui.local').pathname+'">'+fs.readFileSync(asset,'utf8').replace(/<\/script/gi,'<\\/script')+'\n//# sourceURL='+new URL(source,'http://ui.local').pathname+'\n</script>';
  });
  const metadata=modelInfo?JSON.stringify(modelInfo).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'):'';
  if(metadata)expanded=expanded.replace('</head>','<script type="application/json" id="herBootModel">'+metadata+'</script>\n</head>');
  const signature=metadata+'|'+dependencies.map(f=>{const s=fs.statSync(f);return f+':'+s.size+':'+s.mtimeMs;}).join('|');
  if(cache.get(name)?.signature===signature)return cache.get(name);
  const body=Buffer.from(expanded),value={signature,body,gzip:gzipSync(body)};cache.set(name,value);return value;
 };
}
