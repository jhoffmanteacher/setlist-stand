/*
 * One browser run at a time, and only when the Mac is not busy.
 *
 * Every tool that starts a browser (tools/smoke.mjs, tools/loops.mjs, and any scratch script that calls
 * chromium.launch) calls `await acquireSlot('<name>')` first. The slot is a lock directory in the temp folder:
 * a second run waits for the first instead of starting a second Chromium. After taking the slot the run also
 * waits until the 1-minute load average is below 75% of the CPU cores (up to 5 minutes), so it never piles onto
 * a machine that is already working hard. The slot is released when the process exits, however it exits.
 *
 *   SS_NO_SLOT=1   skip the lock (CI runners are single-job machines)       SS_MAX_LOAD=N   change the load limit
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'setlist-stand-browser.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let held = false;

export function releaseSlot(){
  if(!held) return;
  held = false;
  try{ fs.rmSync(LOCK, {recursive: true, force: true}); }catch(e){}
}
const alive = pid => { try{ process.kill(pid, 0); return true; }catch(e){ return e.code === 'EPERM'; } };

export async function acquireSlot(label = 'browser run', {timeoutMs = 60 * 60e3} = {}){
  if(process.env.SS_NO_SLOT || held) return;
  const start = Date.now();
  let told = false;
  for(;;){
    try{
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'owner'), JSON.stringify({pid: process.pid, label, since: Date.now()}));
      held = true; break;
    }catch(e){
      if(e.code !== 'EEXIST') throw e;
      let owner = null;
      try{ owner = JSON.parse(fs.readFileSync(path.join(LOCK, 'owner'), 'utf8')); }catch(err){}
      let age = 0; try{ age = Date.now() - fs.statSync(LOCK).mtimeMs; }catch(err){ continue; }
      const stale = owner ? (!alive(owner.pid) || Date.now() - owner.since > 3 * 3600e3) : age > 10e3;
      if(stale){ try{ fs.rmSync(LOCK, {recursive: true, force: true}); }catch(err){} continue; }
      if(!told){ console.error(`waiting for the browser slot (${owner ? owner.label + ', pid ' + owner.pid : 'starting'}): one browser run at a time`); told = true; }
      if(Date.now() - start > timeoutMs) throw new Error('waited an hour for the browser slot');
      await sleep(2000);
    }
  }
  for(const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseSlot(); if(sig !== 'exit') process.exit(130); });
  // then wait for the machine to calm down
  const limit = Number(process.env.SS_MAX_LOAD) || os.cpus().length * 0.75;
  const t0 = Date.now(); let said = false;
  while(os.loadavg()[0] > limit && Date.now() - t0 < 5 * 60e3){
    if(!said){ console.error(`machine is busy (load ${os.loadavg()[0].toFixed(1)} > ${limit.toFixed(1)}): waiting up to 5 minutes before starting a browser`); said = true; }
    await sleep(5000);
  }
}
