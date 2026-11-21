/* Signing in to Google (the "implicit" redirect flow) and keeping the token. No library, no popup, no server of ours.

   The trip: beginSignIn() writes a one-time note (a random `state`, the time, what the person had tapped) and sends the
   whole page to Google. Google sends it back to the app's start address with the answer after a `#`. takeReturn() (the
   first thing main.js runs) reads that answer, takes the `#` part off the address, checks the answer against the note,
   and only then keeps the token. There is no refresh token in this flow: the token lasts about an hour, then the person
   signs in again.

   Keys (this tablet only, never in a backup or a share package):
     ss-google          {token, exp}            exp = when the token ends (ms)
     ss-google-pending  {state, t, then}        the trip in progress; removed as soon as an answer comes back
   The token is never logged, shown, put in an address or written anywhere else. getToken() is the only reader. */
import {CLIENT_ID, SCOPE, AUTH_URL, redirectUri} from './driveconfig.js';

const TOKEN_KEY = 'ss-google', PENDING_KEY = 'ss-google-pending';
const TRIP_MS = 15 * 60e3;            // an answer for a trip older than this is not believed
export const MARGIN_MS = 60e3;        // a token with less than this left is not used (a request could outlive it)
const MAX_LIFE_S = 86400;             // Google gives about an hour; anything longer than a day is not believed
const THEN = ['connect', 'test'];     // what the person had tapped: carried over the trip so it can carry on afterwards

const read = key => { try{ const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }catch(e){ return null; } };
const drop = key => { try{ localStorage.removeItem(key); }catch(e){} };
const fresh = t => { const age = Date.now() - Number(t); return age >= -60e3 && age <= TRIP_MS; };      // a note is believed for 15 minutes (a minute of clock slack)
const randomState = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

/* Sends the page to Google. Returns {ok:true} when it is on its way, or {ok:false, why:'offline'|'storage'} when it did
   not go (then nothing was changed). It never leaves unless the note for the way back is really written: an answer
   with no note is refused, so going without one would only lose the sign-in. */
export function beginSignIn(then = 'connect'){
  if(navigator.onLine === false) return {ok:false, why:'offline'};
  const trip = {state:randomState(), t:Date.now(), then:THEN.includes(then) ? then : 'connect'};
  try{ localStorage.setItem(PENDING_KEY, JSON.stringify(trip)); }catch(e){ return {ok:false, why:'storage'}; }
  const kept = read(PENDING_KEY);
  if(!kept || kept.state !== trip.state) return {ok:false, why:'storage'};
  const q = new URLSearchParams({client_id:CLIENT_ID, redirect_uri:redirectUri(), response_type:'token', scope:SCOPE, state:trip.state});
  location.assign(AUTH_URL + '?' + q);
  return {ok:true};
}

/* Reads Google's answer from the address, if there is one. Call it once, first thing, before anything else runs.
   Returns null when the address holds no sign-in answer (then it is left alone), else
     {ok:true, then, until}   connected; `until` is when the token ends
     {ok:false, kind, code?}  nothing was kept. kind: denied | error | foreign (no sign-in started in this window) | late
                            (started over 15 minutes ago) | mismatch (the answer is not for the sign-in started here) |
                            short | scope | storage | bad
   The `#` part is taken off the address FIRST, before anything can fail, so the token is never left in the address bar
   or the history. */
export function takeReturn(){
  const p = new URLSearchParams(location.hash.slice(1));
  if(!p.has('access_token') && !p.has('error')){                  // no answer here (or some other # part: not ours)
    const old = read(PENDING_KEY);                                // a trip that never came back does not linger
    if(old && !fresh(old.t)) drop(PENDING_KEY);
    return null;
  }
  try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){}
  const trip = read(PENDING_KEY);
  drop(PENDING_KEY);                                              // one answer per trip, whatever it says
  if(!trip || typeof trip.state !== 'string' || !trip.state) return {ok:false, kind:'foreign'};     // no sign-in was started in THIS window
  if(!fresh(trip.t)) return {ok:false, kind:'late'};                                                // it was, but too long ago
  if(p.get('state') !== trip.state) return {ok:false, kind:'mismatch'};                              // it was, but this answer is not for it
  if(p.has('error')){
    const code = p.get('error');
    return code === 'access_denied' ? {ok:false, kind:'denied'} : {ok:false, kind:'error', code:/^[a-z_]{1,40}$/.test(code) ? code : 'unknown'};
  }
  const token = p.get('access_token'), life = Number(p.get('expires_in')), type = p.get('token_type');
  if(typeof token !== 'string' || token.length < 20 || token.length > 2048 || !/^[\x21-\x7e]+$/.test(token) || (type && type.toLowerCase() !== 'bearer')) return {ok:false, kind:'bad'};
  if(!(life > 0 && life <= MAX_LIFE_S)) return {ok:false, kind:'bad'};
  if(life * 1000 <= MARGIN_MS) return {ok:false, kind:'short'};
  const scope = p.get('scope');
  if(scope !== null && !scope.split(/\s+/).includes(SCOPE)) return {ok:false, kind:'scope'};   // the permission was not given
  const exp = Date.now() + life * 1000;
  try{ localStorage.setItem(TOKEN_KEY, JSON.stringify({token, exp})); }catch(e){ return {ok:false, kind:'storage'}; }
  return {ok:true, then:THEN.includes(trip.then) ? trip.then : 'connect', until:exp};
}

/* The person pressed Cancel after Continue (the page is still on its way to Google): the note for the way back goes. */
export const cancelSignIn = () => drop(PENDING_KEY);
/* Back from Google with the Back button (the page comes out of the browser's cache): that trip was abandoned. */
addEventListener('pageshow', e => { if(e.persisted) drop(PENDING_KEY); });

/* The token, only if it has more than a minute left; otherwise null (the person must sign in again). */
export function getToken(){
  const t = read(TOKEN_KEY);
  return t && typeof t.token === 'string' && t.exp - Date.now() > MARGIN_MS ? t.token : null;
}
/* For the Library line: {state:'none'} | {state:'connected', until} | {state:'expired', until}. Never the token. */
export function signInState(){
  const t = read(TOKEN_KEY);
  if(!t || typeof t.token !== 'string' || !Number.isFinite(t.exp)) return {state:'none'};
  return {state:t.exp - Date.now() > MARGIN_MS ? 'connected' : 'expired', until:t.exp};
}
/* Google said the token is no good (it was taken back, or ended early): forget it. */
export const forgetToken = () => drop(TOKEN_KEY);
/* Disconnect: forget the sign-in on this tablet. Google is not told (that would be a third address); the person can remove
   the app's access from their Google account's security page. */
export function disconnect(){ drop(TOKEN_KEY); drop(PENDING_KEY); }
