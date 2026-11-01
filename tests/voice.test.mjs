import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneVoice, gameVoiceCue } from '../voice.mjs';

function fixture() {
  const started = [], stopped = [], requests = [];
  let now = 0, fails = 0;
  const context = { state: 'running', resume: async () => {}, destination: {},
    decodeAudioData: async data => data,
    createBufferSource() { const s = { connect() {}, disconnect() {}, start() { started.push(s); }, stop() { stopped.push(s); } }; return s; } };
  const voice = new SceneVoice({ contextFactory: () => context, now: () => now,
    onUnavailable: () => fails++, fetchAudio: url => new Promise(resolve => requests.push({url: String(url), resolve})) });
  voice.unlock();
  const resolve = i => requests[i].resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  return { voice, context, started, stopped, requests, resolve, time: n => now = n, failures: () => fails };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('speech replaces previous sound and discards late responses after mute / stop', async () => {
  const f = fixture();
  const a = f.voice.speak('rabbit', 'greeting');
  const b = f.voice.speak('cat', 'greeting');
  f.resolve(1); await b;
  f.resolve(0); await a;
  assert.equal(f.started.length, 1);
  f.voice.setEnabled(false);
  assert.equal(f.stopped.length, 1);
  await f.voice.speak('bear', 'greeting');
  assert.equal(f.requests.length, 2);
  f.voice.setEnabled(true);
  const c = f.voice.speak('bear', 'greeting');
  f.voice.stop(); f.resolve(2); await c;
  assert.equal(f.started.length, 1);
});
test('slow fetch, suspended audio, and rejected fetch never interrupt game', async () => {
  const f = fixture();
  const a = f.voice.speak('rabbit', 'peek'); f.time(1600); f.resolve(0); await a;
  assert.equal(f.started.length, 0);
  f.context.state = 'suspended'; await f.voice.speak('rabbit', 'peek');
  assert.equal(f.started.length, 0);
  const b = f.voice.speak('rabbit', 'found'); f.requests[1].resolve({ok: false}); await b;
  assert.equal(f.failures(), 1);
});
test('state cues occur once, quiet states cancel pending playback and round reset allows speech', async () => {
  const f = fixture();
  const g = { active: true, phase: 'ready', roundIndex: 0 };
  f.voice.sync(g, 'rabbit'); f.voice.sync(g, 'rabbit');
  assert.equal(f.requests.length, 1);
  g.phase = 'counting'; f.voice.sync(g, 'rabbit'); f.resolve(0); await flush();
  assert.equal(f.started.length, 0);
  g.phase = 'paused'; g.reaction = {kind: 'peek', id: 1}; f.voice.sync(g, 'rabbit');
  f.resolve(1); await flush(); assert.equal(f.started.length, 1);
  g.reaction = null; f.voice.sync(g, 'rabbit'); assert.equal(f.stopped.length, 1);
  g.phase = 'ready'; f.voice.sync(g, 'rabbit'); await flush(); assert.equal(f.started.length, 1);
  g.roundIndex = 1; f.voice.sync(g, 'rabbit'); await flush(); assert.equal(f.started.length, 2);
  f.voice.reset(); f.voice.sync(g, 'rabbit'); await flush(); assert.equal(f.started.length, 3);
});
test('waiting/resting, inactive and stale states are silent, loss and return are distinct', () => {
  for (const phase of ['counting', 'waiting-to-seek', 'resting'])
    assert.equal(gameVoiceCue({ active:true, phase, faceMissingConfirmed:true }), null);
  assert.equal(gameVoiceCue({ active:false, phase:'found' }), null);
  assert.equal(gameVoiceCue({ active:true, phase:'found', signalStale:true }), null);
  assert.deepEqual(gameVoiceCue({ active:true, phase:'paused', faceMissingConfirmed:true, faceMissingSince:500 }), {clip:'missing',key:'missing:500'});
  assert.deepEqual(gameVoiceCue({ active:true, phase:'paused', reaction:{kind:'returned',id:2} }), {clip:'returned',key:'reaction:2'});
});
test('unsupported AudioContext is nonfatal and untrusted identifiers never fetch', async () => {
  const voice = new SceneVoice({contextFactory() { throw Error('unsupported'); }});
  voice.unlock(); await voice.speak('rabbit','ready');
  const f = fixture(); await f.voice.speak('../remote','ready'); await f.voice.speak('rabbit','../remote');
  assert.equal(f.requests.length,0);
});

test('all spoken text has a versioned, nonempty asset and matching hash', async () => {
  const {readFile} = await import('node:fs/promises');
  const {createHash} = await import('node:crypto');
  const manifest = JSON.parse(await readFile(new URL('../assets/voices/manifest.json', import.meta.url)));
  assert.equal(manifest.clips.length, 30);
  assert.equal(new Set(manifest.clips.map(c => c.file)).size, 30);
  for (const clip of manifest.clips) {
    const file = await readFile(new URL('../' + clip.file, import.meta.url));
    assert.ok(file.length > 1000);
    assert.equal(createHash('sha256').update(file).digest('hex'), clip.sha256);
    assert.ok(clip.text && clip.credit.startsWith('VOICEVOX:'));
    if (clip.cue === 'returned') assert.ok(clip.duration < .9);
    if (clip.cue === 'peek') assert.ok(clip.duration < 1.6);
  }
});

test('waiting-to-seek completion voice only when face and fresh signal are present', () => {
  assert.deepEqual(gameVoiceCue({active:true,phase:'waiting-to-seek',roundIndex:2,facePresent:true,signalStale:false}),{clip:'done',key:'2:done'});
  assert.equal(gameVoiceCue({active:true,phase:'waiting-to-seek',roundIndex:2,facePresent:false,faceMissingConfirmed:true}),null);
  assert.equal(gameVoiceCue({active:true,phase:'waiting-to-seek',roundIndex:2,facePresent:true,signalStale:true}),null);
});
