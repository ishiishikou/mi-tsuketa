// Pre-recorded, same-origin speech. No microphone, runtime TTS or remote API.
export function gameVoiceCue(game) {
  if (!game || !game.active || ['counting', 'waiting-to-seek', 'resting'].includes(game.phase)) return null;
  if (game.faceMissingConfirmed) return { clip: 'missing', key: `missing:${game.faceMissingSince}` };
  if (game.signalStale) return null;
  if (game.reaction) return { clip: game.reaction.kind, key: `reaction:${game.reaction.id}` };
  if (['ready', 'seeking', 'found'].includes(game.phase)) {
    return { clip: game.phase, key: `${game.roundIndex}:${game.phase}` };
  }
  return null;
}

// Only progress recorded by the existing closed-eye state machine may speak.
export function countdownVoiceCue(game) {
  if (!game?.active || game.phase !== 'counting' || game.signalStale ||
      game.facePresent !== true || game.eyeState !== 'closed' ||
      game.previousEligible !== true ||
      !Number.isFinite(game.targetMs) || !Number.isFinite(game.elapsedMs)) return null;
  const remaining = Math.ceil((game.targetMs - game.elapsedMs) / 1000);
  if (remaining < 1 || remaining > 60 || (remaining > 10 && remaining % 5 !== 0)) return null;
  return { clip: `count-${remaining}`, key: `count:${game.roundIndex}:${remaining}` };
}

export class SceneVoice {
  constructor({ contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    fetchAudio = url => fetch(url), now = () => performance.now(), onUnavailable = () => {} } = {}) {
    this.contextFactory = contextFactory;
    this.fetchAudio = fetchAudio;
    this.now = now;
    this.onUnavailable = onUnavailable;
    this.enabled = true;
    this.context = null;
    this.buffers = new Map();
    this.source = null;
    this.token = 0;
    this.scene = null;
    this.seen = new Set();
  }

  // Call synchronously from a user gesture, before any camera/model awaits (iOS).
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ??= this.contextFactory();
      Promise.resolve(this.context.resume()).catch(() => this.onUnavailable());
    } catch { this.onUnavailable(); }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.stop();
    else this.unlock();
  }

  stop() {
    ++this.token; // Invalidates downloads/decodes still in flight.
    if (this.source) {
      try { this.source.stop(); } catch { /* already ended */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  reset() {
    this.stop();
    this.scene = null;
    this.seen.clear();
  }

  async speak(character, clip) {
    this.stop();
    if (!this.enabled || !this.context) return;
    const token = this.token;
    const started = this.now();
    const key = `${character}/${clip}`;
    // Only fixed internal identifiers can form a URL.
    const isCount = /^count-(?:[1-9]|10|15|20|25|30|35|40|45|50|55|60)$/.test(clip);
    if (!['rabbit', 'bear', 'cat'].includes(character) ||
        (!isCount && !['greeting', 'pet', 'ready', 'peek', 'returned', 'found', 'dark', 'night', 'missing', 'seeking'].includes(clip))) return;
    const filename = isCount
      ? `./assets/voices/countdown/${character}/${clip.slice(6)}.mp3`
      : `./assets/voices/${character}/${clip === "peek" ? "noticed" : clip}.mp3`;
    try {
      if (!this.buffers.has(key)) {
        const pending = this.fetchAudio(new URL(filename, import.meta.url))
          .then(response => {
            if (!response.ok) throw new Error('audio-unavailable');
            return response.arrayBuffer();
          }).then(data => this.context.decodeAudioData(data));
        this.buffers.set(key, pending);
        pending.catch(() => this.buffers.delete(key));
      }
      const buffer = await this.buffers.get(key);
      // Do not deliver old speech after a state change, slow load, or backgrounding.
      if (token !== this.token || !this.enabled || this.now() - started > 1500 || this.context.state !== 'running') return;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => {
        source.disconnect();
        if (this.source === source) this.source = null;
      };
      this.source = source;
      source.start();
    } catch {
      if (token === this.token) this.onUnavailable();
    }
  }

  sync(game, character) {
    const count = countdownVoiceCue(game);
    // Between five-second milestones, let the current encouragement finish.
    // A pause, stale/unknown signal, or phase exit must still stop immediately.
    if (!count && game?.active && game.phase === 'counting' &&
        !game.signalStale && game.facePresent === true &&
        game.eyeState === 'closed' && game.previousEligible === true) return;
    const cue = count ?? gameVoiceCue(game);
    const key = cue ? `${character}:${cue.key}` : null;
    if (this.scene === key) return;
    this.scene = key;
    this.stop();
    if (!cue || this.seen.has(key)) return;
    this.seen.add(key); // Never replay on every frame or after a short reaction.
    void this.speak(character, cue.clip);
  }
}
