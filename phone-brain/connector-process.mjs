/** Inspect only this project's connector; never return its private provisioning route. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";

export async function inspectConnectors({executable,origin,pid}={}){
  if(process.platform!=='win32')return [];
  const filter=Number.isInteger(pid)&&pid>0?'ProcessId='+pid:"Name='cloudflared.exe'";
  const script=`$ErrorActionPreference='Stop'
$connectorExe=${quote(executable)}
$connectorOrigin=${quote(origin)}
$connectorRows=@(Get-CimInstance Win32_Process -Filter ${quote(filter)} | Where-Object {
  $_.ExecutablePath -eq $connectorExe -and $_.CommandLine -match ('(?:^|\\s)--url(?:\\s+|=)"?'+[regex]::Escape($connectorOrigin)+'"?(?:\\s|$)')
} | ForEach-Object {
  $connectorMetrics=0
  if($_.CommandLine -match '--metrics(?:\\s+|=)"?127\\.0\\.0\\.1:(\\d+)'){$connectorMetrics=[int]$Matches[1]}
  if(-not $connectorMetrics){
    $connectorListeners=@(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1'})
    if($connectorListeners.Count -eq 1){$connectorMetrics=$connectorListeners[0].LocalPort}
  }
  [pscustomobject]@{pid=[int]$_.ProcessId;startTime=$_.CreationDate.ToUniversalTime().ToString('o');metricsPort=[int]$connectorMetrics}
})
ConvertTo-Json -InputObject $connectorRows -Compress`;
  try{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:12000,maxBuffer:65536});
    const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
    return (Array.isArray(rows)?rows:[rows]).filter(row=>Number.isInteger(row?.pid)&&row.pid>0&&typeof row.startTime==='string');
  }catch{throw new Error('connector-inspection-unavailable');}
}

export function connectorAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}

export async function inspectStableHelpers({executable,helper,origin,stateDir,pid}={}){
 if(process.platform!=='win32')return [];
 const filter=Number.isInteger(pid)&&pid>0?'ProcessId='+pid:"Name='node.exe'";
 const script=`$ErrorActionPreference='Stop'
$entryRows=@(Get-CimInstance Win32_Process -Filter ${quote(filter)} | Where-Object {
 $_.ExecutablePath -eq ${quote(executable)} -and $_.CommandLine.Contains(${quote(helper)}) -and $_.CommandLine.Contains(${quote('--origin='+origin)}) -and $_.CommandLine.Contains(${quote('--state-dir='+stateDir)})
} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;startTime=$_.CreationDate.ToUniversalTime().ToString('o')}})
ConvertTo-Json -InputObject $entryRows -Compress`;
 try{const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:12000,maxBuffer:65536});const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));return (Array.isArray(rows)?rows:[rows]).filter(x=>Number.isInteger(x?.pid)&&typeof x.startTime==='string');}
 catch{throw Error('stable-helper-inspection-unavailable');}
}

export async function inspectStableSsh({executable,keyFile,origin,pid}={}){
 if(process.platform!=='win32')return [];
 const filter=Number.isInteger(pid)&&pid>0?'ProcessId='+pid:"Name='ssh.exe'",reverse='80:127.0.0.1:'+new URL(origin).port;
 const script=`$ErrorActionPreference='Stop'
$entryRows=@(Get-CimInstance Win32_Process -Filter ${quote(filter)} | Where-Object {
 $_.ExecutablePath -eq ${quote(executable)} -and $_.CommandLine.Contains(${quote(keyFile)}) -and $_.CommandLine -match '(?:^|\\s)stable@proxy\\.tunnl\\.gg(?:\\s|$)' -and $_.CommandLine -match ('(?:^|\\s)-R\\s+"?'+[regex]::Escape(${quote(reverse)})+'"?(?:\\s|$)')
} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;startTime=$_.CreationDate.ToUniversalTime().ToString('o')}})
ConvertTo-Json -InputObject $entryRows -Compress`;
 try{const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:12000,maxBuffer:65536});const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));return (Array.isArray(rows)?rows:[rows]).filter(x=>Number.isInteger(x?.pid)&&typeof x.startTime==='string');}
 catch{throw Error('stable-ssh-inspection-unavailable');}
}

export async function inspectSshConnectors({executable,origin,pid}={}){
  if(process.platform!=='win32')return [];
  const port=new URL(origin).port,filter=Number.isInteger(pid)&&pid>0?'ProcessId='+pid:"Name='ssh.exe'";
  const script=`$ErrorActionPreference='Stop'
$sshProjectExe=${quote(executable)}
$sshProjectReverse=${quote('80:127.0.0.1:'+port)}
$sshProjectRows=@(Get-CimInstance Win32_Process -Filter ${quote(filter)} | Where-Object {
  $_.ExecutablePath -eq $sshProjectExe -and $_.CommandLine -match ('(?:^|\\s)-R\\s+"?'+[regex]::Escape($sshProjectReverse)+'"?(?:\\s|$)') -and $_.CommandLine -match '(?:^|\\s)nokey@localhost\\.run(?:\\s|$)'
} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;startTime=$_.CreationDate.ToUniversalTime().ToString('o')}})
ConvertTo-Json -InputObject $sshProjectRows -Compress`;
  try{const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:12000,maxBuffer:65536});const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));return (Array.isArray(rows)?rows:[rows]).filter(x=>Number.isInteger(x?.pid)&&typeof x.startTime==='string');}
  catch{throw new Error('ssh-connector-inspection-unavailable');}
}
