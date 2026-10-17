// Pure browser-side game state; no camera frames or user data leave the device.
export const ROUND_SECONDS = Object.freeze([10, 15, 20, 30, 45, 60]);
export const HIDING_SPOTS = Object.freeze(["tree", "house", "flower"]);

export class HideAndSeekGame {
  constructor({ roundSeconds = ROUND_SECONDS, spots = HIDING_SPOTS, random = Math.random } = {}) {
    this.roundSeconds = roundSeconds;
    this.spots = spots;
    this.random = random;
    this.roundIndex = 0;
    this.phase = "ready";
    this.elapsedMs = 0;
    this.lastTickAt = null;
    this.eyeState = "unknown";
    this.facePresent = false;
    this.hiddenSpot = null;
    this.wrongGuess = null;
  }

  get targetMs() {
    return this.roundSeconds[Math.min(this.roundIndex, this.roundSeconds.length - 1)] * 1000;
  }

  get remainingSeconds() {
    return Math.max(0, Math.ceil((this.targetMs - this.elapsedMs) / 1000));
  }

  tick(now, visible = true) {
    if (this.lastTickAt === null) {
      this.lastTickAt = now;
      return;
    }
    // Clamp a delayed callback: backgrounded/throttled tabs must not count as closed-eye playtime.
    const delta = Math.max(0, Math.min(now - this.lastTickAt, 1000));
    this.lastTickAt = now;
    if (!visible || !this.facePresent || this.eyeState !== "closed" || this.phase !== "counting") return;
    this.elapsedMs = Math.min(this.targetMs, this.elapsedMs + delta);
    if (this.elapsedMs >= this.targetMs) {
      this.phase = "waiting-to-seek"; // Stay quiet while the child keeps their eyes closed.
      const index = Math.max(0, Math.min(this.spots.length - 1, Math.floor(this.random() * this.spots.length)));
      this.hiddenSpot = this.spots[index];
    }
  }

  observe({ facePresent, eyeState }, now) {
    // A state change cannot retroactively credit an unobserved gap to closed eyes.
    this.tick(now, false);
    this.facePresent = Boolean(facePresent);
    this.eyeState = this.facePresent ? eyeState : "unknown";
    if (!this.facePresent) {
      // Never mistake a lost face for successful closed eyes.
      if (this.phase === "counting" || this.phase === "waiting-to-seek") {
        this.phase = "ready";
        this.elapsedMs = 0;
        this.hiddenSpot = null;
      }
      return;
    }
    if (this.phase === "ready" && eyeState === "closed") {
      this.phase = "counting";
      this.elapsedMs = 0;
      this.wrongGuess = null;
    } else if (this.phase === "counting" && eyeState === "open") {
      // Issue #9 will add the playful 'caught peeking' photo. For now, reset safely.
      this.phase = "ready";
      this.elapsedMs = 0;
    } else if (this.phase === "waiting-to-seek" && eyeState === "open") {
      this.phase = "seeking";
    }
  }

  guess(spot) {
    if (this.phase !== "seeking" || !this.facePresent || !this.spots.includes(spot)) return false;
    if (spot !== this.hiddenSpot) {
      this.wrongGuess = spot;
      return false;
    }
    this.phase = "found";
    this.wrongGuess = null;
    return true;
  }

  nextRound(now) {
    if (this.phase !== "found") return false;
    this.roundIndex += 1;
    this.phase = "ready";
    this.elapsedMs = 0;
    this.hiddenSpot = null;
    this.wrongGuess = null;
    this.lastTickAt = now;
    return true;
  }
}
