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
    if (!['rabbit', 'bear', 'cat'].includes(character) ||
        !['greeting', 'pet', 'ready', 'peek', 'returned', 'found', 'dark', 'night', 'missing', 'seeking'].includes(clip)) return;
    try {
      if (!this.buffers.has(key)) {
        const pending = this.fetchAudio(new URL(`./assets/voices/${character}/${clip === "peek" ? "noticed" : clip}.mp3`, import.meta.url))
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
    const cue = gameVoiceCue(game);
    const key = cue ? `${character}:${cue.key}` : null;
    if (this.scene === key) return;
    this.scene = key;
    this.stop();
    if (!cue || this.seen.has(key)) return;
    this.seen.add(key); // Never replay on every frame or after a short reaction.
    void this.speak(character, cue.clip);
  }
}
