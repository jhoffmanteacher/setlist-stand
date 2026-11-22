/*
 * At most TWO browser runs at a time (Jonathan, 2026-11-21; it was one), and only when the Mac is not busy.
 *
 * Every tool that starts a browser (tools/smoke.mjs, tools/loops.mjs, and any scratch script that calls
 * chromium.launch) calls `await acquireSlot('<name>')` first. A slot is a lock directory in the temp folder
 * (setlist-stand-browser.lock and setlist-stand-browser-2.lock): a run that finds every slot taken
 * waits instead of starting another Chromium. After taking a slot the run also waits (up to 5 minutes) until the 1-minute
 * load average is below 75% of the CPU cores AND the CPUs have really been less than 70% busy over the last two seconds
 * (the load average lags by a minute, so several runs starting together would all see a quiet machine).
 * Measured on Jonathan's Mac (Intel i5, 8 logical cores, 16 GB), 2026-11-21: with nothing running the load is 1 to 2.5; each
 * active run adds about 2 (a Chromium run is about 1 core and 600 to 800 MB, plus the node test process and the page's own
 * work); THREE runs at once gave a load of 7.4 on average and 10 at the peak, and on a second try 5.85 and 8.4 (limit 6), so two is the default and three only for a run when nothing else is busy (SS_SLOTS=3).
 * The slot is released when the process exits, however it exits. The first lock keeps its old name, so an older copy of
 * this file (another worktree that has not been rebased yet) still takes the first slot and the two kinds of run never
 * share a slot.
 *
 *   SS_NO_SLOT=1   skip the lock (CI runners are single-job machines)       SS_MAX_LOAD=N   change the load limit
 *   SS_SLOTS=N     how many runs at once (default 2; 1 gives the old rule)       SS_MAX_BUSY=F   the busy-CPU limit, 0 to 1 (default 0.7)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SLOTS = Math.max(1, Number(process.env.SS_SLOTS) || 2);
const LOCKS = Array.from({length: SLOTS}, (_, i) => path.join(os.tmpdir(), i === 0 ? 'setlist-stand-browser.lock' : `setlist-stand-browser-${i + 1}.lock`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let held = null;                                    // the lock directory this process holds

export function releaseSlot(){
  if(!held) return;
  const lock = held; held = null;
  try{ fs.rmSync(lock, {recursive: true, force: true}); }catch(e){}
}
const alive = pid => { try{ process.kill(pid, 0); return true; }catch(e){ return e.code === 'EPERM'; } };

/* Takes one lock directory if it is free (or left by a run that is gone). Returns true, or the owner's description when it is busy. */
function tryTake(lock, label){
  for(;;){
    try{
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({pid: process.pid, label, since: Date.now()}));
      held = lock; return true;
    }catch(e){
      if(e.code !== 'EEXIST') throw e;
      let owner = null;
      try{ owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); }catch(err){}
      let age = 0; try{ age = Date.now() - fs.statSync(lock).mtimeMs; }catch(err){ continue; }
      const stale = owner ? (!alive(owner.pid) || Date.now() - owner.since > 3 * 3600e3) : age > 10e3;
      if(stale){ try{ fs.rmSync(lock, {recursive: true, force: true}); }catch(err){} continue; }
      return owner ? owner.label + ', pid ' + owner.pid : 'starting';
    }
  }
}

export async function acquireSlot(label = 'browser run', {timeoutMs = 60 * 60e3} = {}){
  if(process.env.SS_NO_SLOT || held) return;
  const start = Date.now();
  let told = false;
  for(;;){
    const busy = [];
    for(const lock of LOCKS){ const r = tryTake(lock, label); if(r === true) break; busy.push(r); }
    if(held) break;
    if(!told){ console.error(`waiting for a browser slot (${SLOTS === 1 ? 'one browser run at a time' : SLOTS + ' at a time'}; in use: ${busy.join('; ')})`); told = true; }
    if(Date.now() - start > timeoutMs) throw new Error('waited an hour for a browser slot');
    await sleep(2000);
  }
  for(const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseSlot(); if(sig !== 'exit') process.exit(130); });
  // then wait for the machine to calm down: the load average is low AND the CPUs are really not busy right now
  const limit = Number(process.env.SS_MAX_LOAD) || os.cpus().length * 0.75, maxBusy = Number(process.env.SS_MAX_BUSY) || 0.7;
  const t0 = Date.now(); let said = false;
  for(;;){
    const busyNow = await cpuBusy(1500);
    if(os.loadavg()[0] <= limit && busyNow < maxBusy) break;
    if(Date.now() - t0 > 5 * 60e3) break;
    if(!said){ console.error(`machine is busy (load ${os.loadavg()[0].toFixed(1)}, limit ${limit.toFixed(1)}; CPUs ${Math.round(busyNow * 100)}% busy, limit 70%): waiting up to 5 minutes before starting a browser`); said = true; }
    await sleep(3500);
  }
}
/* The share of CPU time the machine spent working over the next `ms` milliseconds (0 to 1). */
async function cpuBusy(ms){
  const take = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, {idle:0, all:0});
  const a = take(); await sleep(ms); const b = take();
  const all = b.all - a.all;
  return all > 0 ? 1 - (b.idle - a.idle) / all : 0;
}
