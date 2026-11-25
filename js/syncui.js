/* The Google Drive control (Jonathan, 2026-11-22: it lives in the Library's Back up / Sync menu): "Google Drive settings" opens
   the Google Drive box (Sync, Connect, "Connected until ...", Disconnect, "Last synced"), and the bottom of the
   Library keeps one read-only line with the same status sentence. Also what the app says when it comes back from Google.
   Everything here happens only when a button is tapped (or when the page returns from a sign-in the person started, to carry
   on with what they had tapped). Sync itself is js/sync.js; its boxes are js/syncdialogs.js. The sign-in is kept in memory only
   (js/googleauth.js), so after a reload, an app update or a closed app the person taps Sync (or Connect) and signs in again. */
import {$, esc, toast, modal, busy, hooks} from './util.js';
import {logProblem} from './errors.js';
import {FOLDER_NAME} from './driveconfig.js';
import {beginSignIn, cancelSignIn, signInState, getToken, disconnect} from './googleauth.js';
import {load} from './store.js';
import {runSync, Stopped, Failed, lastSync, blankReport} from './sync.js';
import {introDialog, deletionDialog, reportDialog, failureText} from './syncdialogs.js';

const clock = t => {
  const d = new Date(t), time = d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  return d.toDateString() === new Date().toDateString() ? time : `${time} on ${d.toLocaleDateString([], {month:'short', day:'numeric'})}`;
};
/* The manifest says display "fullscreen", so the installed Android app matches fullscreen, not standalone; the iPad's Home Screen app sets navigator.standalone. */
const inApp = () => { try{ return ['fullscreen', 'standalone', 'minimal-ui'].some(m => matchMedia(`(display-mode: ${m})`).matches) || navigator.standalone === true; }catch(e){ return false; } };

/* A message that stays until OK (never a toast that vanishes). */
function notice(title, text){
  const m = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="pri" data-x data-ok>OK</button></div>`);
  m.querySelector('[data-ok]').onclick = () => { m.remove(); refocus(); };
  return m;
}
/* A dialog gives focus back to the button that opened it; when the Google Drive box was redrawn meanwhile that button is gone,
   so put focus on the box's first button (or, with the box closed, on the Library's Back up / Sync button) instead of leaving
   it on the page. */
function refocus(){
  const a = document.activeElement;
  if(a && a !== document.body && a.isConnected) return;
  const b = $('#driveCtl button') || $('#libMenus [data-backupmenu]'); if(b) b.focus();
}

/* The state in words, and the buttons that go with it. The status sentence is drawn twice: alone (no buttons) in the read-only
   line at the bottom of the Library (#libDriveLine), and with the buttons in the Google Drive box (#driveCtl) while it is open. */
function driveParts(){
  const s = signInState(), t = lastSync();
  const last = t ? `Last synced ${esc(clock(t))}.` : 'Not synced on this tablet yet.';
  if(s.state === 'connected') return {cls:'hint', text:`Connected to Google Drive until ${esc(clock(s.until))}. ${last}`,
    buttons:'<button class="pri" data-syncnow>Sync</button><button data-drivedisconnect>Disconnect</button>'};
  if(s.state === 'expired') return {cls:'hint warnline', text:`Your Google sign-in ran out at ${esc(clock(s.until))}. Tap Sync or Connect again. ${last}`,
    buttons:'<button class="pri" data-syncnow>Sync</button><button data-driveconnect>Connect again</button><button data-drivedisconnect>Disconnect</button>'};
  return {cls:'hint', first:true, text:`Sync keeps your songs, setlists, collections and your pen marks and notes the same on your tablets, through your own Google Drive. ${last} Sync is not a backup.`,
    buttons:'<button class="pri" data-syncnow>Sync</button><button data-driveconnect>Connect Google Drive</button>'};
}
/* Drawn only when something changed: a dialog gives focus back to the button that opened it, so that button must still be there. */
function draw(el, html){
  if(!el || el.dataset.shown === html) return;
  el.dataset.shown = html; el.innerHTML = html;
}
export function renderDrive(){
  const p = driveParts(), line = `<p class="${p.cls}" data-drivestatus>${p.text}</p>`, bar = `<div class="bar">${p.buttons}</div>`;
  draw($('#libDriveLine'), line);
  draw($('#driveCtl'), p.first ? bar + line : line + bar);
}
/* True when Drive has been used on this tablet: signed in now (or earlier in this visit), or synced here before. The Back up /
   Sync menu's "Sync with Google Drive" says "Connect Google Drive first" otherwise. */
export function driveSetUp(){
  return signInState().state !== 'none' || lastSync() > 0;
}
/* The Google Drive box: what the Library's Drive control held, in one dialog with Close. It is redrawn in place while it is open
   (a test result, a Disconnect, the sign-in running out), and its buttons act exactly as the old control's did. */
export function openDriveBox(){
  if(document.querySelector('.modal.drivebox')) return;
  const m = modal('<h2>Google Drive</h2><div id="driveCtl"></div><div class="btns"><button data-x>Close</button></div>');
  m.classList.add('drivebox');
  m.querySelector('[data-x]').onclick = () => { m.remove(); refocus(); };
  m.addEventListener('click', e => { const b = e.target.closest('#driveCtl button'); if(b){ b.focus(); driveClick(b, b.dataset); } });     // Safari does not focus a tapped button: the dialog this opens would remember the page, not the button, and give focus back to the page
  renderDrive();
}
/* The line says when the sign-in ends: bring it up to date when the tablet is picked up again. */
document.addEventListener('visibilitychange', () => { if(!document.hidden) renderDrive(); });
addEventListener('pageshow', e => { if(e.persisted) renderDrive(); });             // a page brought back by the Back button was not redrawn

const NOT_SENT = {
  offline: 'You are offline. Connect to the internet, then tap Connect again. Nothing was changed.',
  storage: 'This browser would not keep the notes the sign-in needs, so it did not start. Nothing was changed.',
};
/* Sends the page to Google. If it cannot go, says why and changes nothing. */
function go(then, dialog){
  const r = beginSignIn(then);
  if(r.ok) return;                         // the page is leaving
  if(dialog) dialog.remove();
  notice('Cannot connect', NOT_SENT[r.why] || NOT_SENT.storage);
}

/* A dialog whose OK sends the page to Google. Cancel (or Escape) after OK must really stop the trip: the browser is
   already on its way, and without window.stop() Google's page (or the browser's no-internet page) would replace the app a
   moment later, maybe in the middle of a song. */
function leaveDialog(m, then){
  const ok = m.querySelector('[data-ok]'); let leaving = false;
  m.querySelector('[data-x]').onclick = () => { if(leaving){ try{ window.stop(); }catch(e){} cancelSignIn(); } m.remove(); refocus(); };
  ok.onclick = () => { ok.disabled = true; m.querySelector('[data-x]').focus(); leaving = true; go(then, m); };    // a switched-off button drops focus to the page: Escape would no longer reach the dialog
  addEventListener('pageshow', e => { if(e.persisted && m.isConnected){ ok.disabled = false; leaving = false; } }, {once:true});   // came back with the Back button
}
function connectDialog(then = 'connect'){
  leaveDialog(modal(`<h2>Connect Google Drive</h2><p>Google will ask you to sign in and to let ChartShark use its own folder in your Drive. The app can see only the files it makes itself. You come back to this app afterwards.</p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Continue</button></div>`), then);
}

/* The sign-in ran out (or was taken back): say so, and offer to sign in again for what the person was doing. */
function signedOutDialog(then){
  const sync = then === 'sync';
  leaveDialog(modal(`<h2>${sync ? 'Sign in to sync' : 'Sign in again'}</h2><p>${sync ? 'Sync needs you to sign in to Google first. You come back to this app afterwards and the sync starts by itself.' : 'Your Google sign-in has run out. Tap Connect again. Nothing was changed.'}</p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>${sync ? 'Continue' : 'Connect again'}</button></div>`), then);
}

/* ---------- Sync ---------- */
const INTRO = 'ss-sync-intro';          // localStorage: the first-time note was read (this tablet only)
const seenIntro = () => { try{ return localStorage.getItem(INTRO) === '1'; }catch(e){ return false; } };
let syncing = false;                    // one run at a time
export async function syncNow(){
  if(syncing) return;
  if(!seenIntro()){ if(!(await introDialog())) return; try{ localStorage.setItem(INTRO, '1'); }catch(e){} }
  if(!getToken()){ renderDrive(); return signedOutDialog('sync'); }         // sign in first; the sync carries on by itself when the page comes back
  syncing = true;
  const job = busy('Syncing', 'Looking at your Google Drive…');
  const ac = new AbortController(), watch = setInterval(() => { if(job.stopped) ac.abort(); }, 150);
  let rep = blankReport(), state = 'done', failure = '';
  try{ rep = await runSync({say:job.say, stopped:() => job.stopped, signal:ac.signal, decide:deletionDialog}); }
  catch(err){
    if(err instanceof Stopped){ state = 'stopped'; rep = err.report; }
    else{
      state = 'failed'; if(err instanceof Failed) rep = err.report;
      const cause = err instanceof Failed ? err.cause : err;
      failure = failureText(cause);
      if(!(cause && cause.plain)) logProblem('sync', String(cause && cause.message || cause).slice(0, 200), {quiet:true});
    }
  }finally{ clearInterval(watch); job.close(); syncing = false; }
  try{ await load(); }catch(e){}
  hooks.render(); renderDrive();
  const m = reportDialog(rep, state, failure), ok = m.querySelector('[data-ok]'), closeIt = ok.onclick;
  ok.onclick = () => { closeIt(); refocus(); };            // the Sync button that opened it was redrawn meanwhile: focus goes to the Google Drive box, or the Back up / Sync button
}

function disconnectDialog(){
  const m = modal(`<h2>Disconnect Google Drive?</h2><p>This tablet forgets the sign-in. Your songs on this tablet and the "${esc(FOLDER_NAME)}" folder in your Drive are not touched. To take the app's access away completely, use the security page of your Google account.</p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Disconnect</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = () => { disconnect(); m.remove(); toast('Disconnected from Google Drive.'); renderDrive(); const b = $('#driveCtl button'); if(b) b.focus(); else refocus(); };
}

/* Returns true when the click was for the Drive control. */
export async function driveClick(b, d){
  if('driveconnect' in d){ connectDialog('connect'); return true; }
  if('syncnow' in d){ await syncNow(); return true; }
  if('drivedisconnect' in d){ disconnectDialog(); return true; }
  return false;
}

const RETURN_FAILED = {
  denied: 'You did not allow access, so Google Drive is not connected. Nothing was changed.',
  foreign: () => `This sign-in answer did not come from a sign-in started in this window, so it was ignored. Nothing was changed. (This window is ${inApp() ? 'the installed app' : 'the browser, not the installed app'}.)`,
  late: 'The sign-in took more than 15 minutes, so its answer was ignored. Nothing was changed. Tap Connect and try again.',
  mismatch: 'This sign-in answer did not match the sign-in started here (another window may have started its own), so it was ignored. Nothing was changed. Tap Connect and try again.',
  short: 'Google gave a sign-in that ends right away, so it was not used. Nothing was changed. Try again.',
  scope: 'Google did not give this app permission to use its Drive folder. Nothing was changed. Tap Connect and allow it.',
  bad: "Google's answer was not what the app expected. Nothing was changed. Try again.",
};
/* After the page came back from Google (main.js passes what takeReturn() found). */
export async function announceSignIn(r){
  if(!r) return;
  renderDrive();
  if(r.ok){
    toast('Connected to Google Drive.');
    if(r.then === 'sync') await syncNow();            // the person had tapped Sync: carry on with it (an old note that says 'test' just connects)
    return;
  }
  const t = r.kind === 'error' ? `Google could not sign you in (${r.code}). Nothing was changed.` : RETURN_FAILED[r.kind];
  notice('Not connected', typeof t === 'function' ? t() : t || RETURN_FAILED.bad);
}
