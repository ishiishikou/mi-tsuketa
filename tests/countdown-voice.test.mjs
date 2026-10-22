import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SceneVoice, countdownVoiceCue, gameVoiceCue } from '../voice.mjs';
import { gamePresentation } from '../characters.mjs';

function counting({ target = 10000, elapsed = 0, round = 0, ...overrides } = {}) {
  return { active: true, phase: 'counting', roundIndex: round, facePresent: true,
    eyeState: 'closed', previousEligible: true, targetMs: target, elapsedMs: elapsed,
    signalStale: false, ...overrides };
}

test('countdown cue derives only from actual eligible closed-eye progress', () => {
  assert.deepEqual(countdownVoiceCue(counting()), {clip:'count-10',key:'count:0:10'});
  assert.deepEqual(countdownVoiceCue(counting({elapsed:1000})), {clip:'count-9',key:'count:0:9'});
  assert.deepEqual(countdownVoiceCue(counting({target:30000})), {clip:'count-30',key:'count:0:30'});
  assert.equal(countdownVoiceCue(counting({target:30000,elapsed:1000})), null);
  assert.deepEqual(countdownVoiceCue(counting({target:60000,elapsed:5000})),
    {clip:'count-55',key:'count:0:55'});
  assert.deepEqual(countdownVoiceCue(counting({target:15000,elapsed:5000})),
    {clip:'count-10',key:'count:0:10'});
  for (const extra of [
    {phase:'paused'}, {phase:'waiting-to-seek'}, {phase:'resting'}, {active:false},
    {facePresent:false}, {eyeState:'unknown'}, {previousEligible:false},
    {signalStale:true}, {targetMs:NaN}, {elapsedMs:Infinity}, {elapsedMs:10000}
  ]) assert.equal(countdownVoiceCue(counting(extra)), null, JSON.stringify(extra));
  assert.deepEqual(countdownVoiceCue(counting({round:1})), {clip:'count-10',key:'count:1:10'});
});

test('countdown pauses immediately, resumes without repeating a previously spoken number', async () => {
  const requested=[], started=[], stopped=[];
  const audio = { state:'running', destination:{}, resume:async()=>{},
    decodeAudioData: async ab=>ab,
    createBufferSource(){ return {connect(){},disconnect(){},
      start(){started.push(true)},stop(){stopped.push(true)}}; }};
  const sound = new SceneVoice({contextFactory:()=>audio,
    fetchAudio:url=>{requested.push(String(url)); return Promise.resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)});},
    now:()=>0});
  sound.unlock();
  const flush = () => new Promise(resolve=>setImmediate(resolve));
  const g=counting({target:30000});
  sound.sync(g,'bear'); await flush();
  assert.equal(started.length,1);
  assert.match(requested[0], /countdown\/bear\/30\.mp3$/);
  g.elapsedMs=1800; sound.sync(g,'bear'); await flush();
  assert.equal(stopped.length,0, 'long encouragement is not cut off at non-milestone seconds');
  g.phase='paused'; sound.sync(g,'bear');
  assert.equal(stopped.length,1);
  g.phase='counting'; g.elapsedMs=2200; sound.sync(g,'bear');
  assert.equal(requested.length,1,'old milestone must not replay on resume');
  g.elapsedMs=5000; sound.sync(g,'bear'); await flush();
  assert.equal(started.length,2);
  assert.match(requested[1], /countdown\/bear\/25\.mp3$/);
  g.facePresent=false; sound.sync(g,'bear');
  assert.equal(stopped.length,2,'face loss must stop playback');
  g.facePresent=true; g.elapsedMs=21000; sound.sync(g,'bear'); await flush();
  assert.match(requested[2], /countdown\/bear\/9\.mp3$/);
  sound.setEnabled(false);
  assert.equal(stopped.length,3);
  g.elapsedMs=22000; sound.sync(g,'bear'); await flush();
  assert.equal(started.length,3,'muted audio must not start');
  sound.reset(); sound.setEnabled(true);
  g.roundIndex=1; g.targetMs=15000; g.elapsedMs=0;
  sound.sync(g,'cat'); await flush();
  assert.match(requested.at(-1), /countdown\/cat\/15\.mp3$/);
});

test('all 63 authored countdown and completion sounds have checked integrity and short final-ten timing', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/voices/countdown-manifest.json',import.meta.url)));
  assert.equal(manifest.clips.length,63);
  assert.equal(new Set(manifest.clips.map(c=>c.file)).size,63);
  for (const animal of ['rabbit','bear','cat']) {
    assert.equal(manifest.clips.filter(c=>c.character===animal).length,21);
  }
  for (const c of manifest.clips) {
    assert.ok(c.text && c.credit.startsWith('VOICEVOX:'));
    assert.equal(c.cue, c.remainingSeconds === undefined ? 'done' : `count-${c.remainingSeconds}`);
    const data = await readFile(new URL('../' + c.file,import.meta.url));
    assert.ok(data.length>500);
    assert.equal(createHash('sha256').update(data).digest('hex'),c.sha256);
    assert.ok(c.duration>.15 && c.duration<(c.remainingSeconds<=10?1.05:4.5));
  }
});

test('finished countdown speaks once at the actual completion, invites opening, and stays audible through seeking', async () => {
  const requests=[], started=[], stopped=[];
  const context={state:'running',destination:{},resume:async()=>{},
    decodeAudioData:async x=>x,
    createBufferSource(){return {connect(){},disconnect(){},start(){started.push(true)},stop(){stopped.push(true)}}}};
  const sound=new SceneVoice({contextFactory:()=>context,now:()=>0,
    fetchAudio:url=>{requests.push(String(url));return Promise.resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)});}});
  sound.unlock();
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const g=counting({target:10000,elapsed:9000});
  sound.sync(g,'rabbit');await flush();
  assert.match(requests.at(-1),/countdown\/rabbit\/1\.mp3$/);
  assert.equal(started.length,1);
  g.elapsedMs=10000;g.phase='waiting-to-seek';g.previousEligible=false;
  assert.deepEqual(gameVoiceCue(g),{clip:'done',key:'0:done'});
  sound.sync(g,'rabbit');await flush();
  assert.match(requests.at(-1),/countdown\/rabbit\/done\.mp3$/);
  assert.equal(started.length,2);
  g.phase='seeking';g.eyeState='open';sound.sync(g,'rabbit');await flush();
  assert.equal(requests.length,2,'do not repeat seeking voice immediately on eye opening');
  assert.equal(stopped.length,1,'completion prompt continues while eyes open');
  g.phase='found';sound.sync(g,'rabbit');await flush();
  assert.match(requests.at(-1),/voices\/rabbit\/found\.mp3$/);
  assert.equal(stopped.length,2);
  g.roundIndex=1;g.phase='waiting-to-seek';g.eyeState='closed';
  sound.sync(g,'rabbit');await flush();
  assert.equal(started.length,4,'new round may announce its own completion');
  g.facePresent=false;g.faceMissingConfirmed=true;
  sound.sync(g,'rabbit');
  assert.equal(stopped.length,4,'missing face silences finished prompt');
  assert.equal(gameVoiceCue(g),null);
});

test('completed countdown instructs opening the eyes rather than showing silent ellipsis', () => {
  const g=counting({target:10000,elapsed:10000,phase:'waiting-to-seek',previousEligible:false});
  const message=gamePresentation(g,'rabbit').text;
  assert.match(message,/もういいよ/);
  assert.match(message,/めを あけて/);
  assert.match(message,/さがしてね/);
  assert.notEqual(message,'…');
});
