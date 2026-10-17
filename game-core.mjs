// Camera-free state machine. Only fresh observations can award closed-eye time.
export const ROUND_SECONDS = Object.freeze([10, 15, 20, 30, 45, 60]);
export const HIDING_SPOTS = Object.freeze(["tree", "house", "flower"]);
export const MAX_SAMPLE_GAP_MS = 750;
export const FACE_LOST_MS = 1000;
export const PEEK_REACTION_MS = 1600;
export const RETURN_REACTION_MS = 900;
export const QUIET_REST_MS = 60_000;

export class HideAndSeekGame {
  constructor({ roundSeconds = ROUND_SECONDS, spots = HIDING_SPOTS, random = Math.random } = {}) {
    this.roundSeconds = roundSeconds;
    this.spots = spots;
    this.random = random;
    this.roundIndex = 0;
    this.active = true;
    this.facePresent = false;
    this.eyeState = "unknown";
    this.lastObservedAt = null;
    this.faceMissingSince = null;
    this.faceMissingConfirmed = false;
    this.signalStale = false;
    this.reactionSequence = 0;
    this.resetRound();
  }

  resetRound() {
    this.phase = "ready";
    this.elapsedMs = 0;
    this.hiddenSpot = null;
    this.wrongGuess = null;
    this.triedSpots = new Set();
    this.pauseReason = null;
    this.reaction = null;
    this.previousEligible = false;
    this.peekArmed = false;
    this.quietClosedSince = null;
  }

  get targetMs() {
    return this.roundSeconds[Math.min(this.roundIndex, this.roundSeconds.length - 1)] * 1000;
  }

  get remainingSeconds() {
    return Math.max(0, Math.ceil((this.targetMs - this.elapsedMs) / 1000));
  }

  pause(reason) {
    this.previousEligible = false;
    if (this.phase === "counting" || this.phase === "paused") {
      this.phase = "paused";
      this.pauseReason = reason;
    }
  }

  react(kind, now, duration) {
    this.reaction = { kind, id: ++this.reactionSequence, until: now + duration };
    this.previousEligible = false;
  }

  // Animation frames expire presentation timers; they never extrapolate eye state.
  tick(now, visible = this.active) {
    if (!visible) {
      this.suspend();
      return;
    }
    if (this.reaction && now >= this.reaction.until) this.reaction = null;
    if (this.faceMissingSince !== null && now - this.faceMissingSince >= FACE_LOST_MS) {
      this.faceMissingConfirmed = true;
      this.pause("face-lost");
    }
    if (this.lastObservedAt !== null && now - this.lastObservedAt > MAX_SAMPLE_GAP_MS) {
      this.signalStale = true;
      this.quietClosedSince = null;
      this.pause("signal");
    }
  }

  observe({ facePresent, eyeState, rawEyeState = eyeState }, now) {
    if (!this.active || !Number.isFinite(now) ||
        (this.lastObservedAt !== null && now <= this.lastObservedAt)) return;
    this.tick(now);
    const gap = this.lastObservedAt === null ? Infinity : now - this.lastObservedAt;
    this.lastObservedAt = now;
    this.signalStale = false;
    this.facePresent = Boolean(facePresent);
    this.eyeState = this.facePresent ? eyeState : "unknown";

    if (!this.facePresent) {
      this.faceMissingSince ??= now;
      this.reaction = null;
      this.quietClosedSince = null;
      this.pause(this.faceMissingConfirmed ? "face-lost" : "uncertain");
      return;
    }

    const returned = this.faceMissingConfirmed;
    this.faceMissingSince = null;
    this.faceMissingConfirmed = false;
    if (returned && this.phase !== "waiting-to-seek" && this.phase !== "resting") {
      this.react("returned", now, RETURN_REACTION_MS);
      this.peekArmed = false;
    }

    const closed = eyeState === "closed" && rawEyeState === "closed";
    const open = eyeState === "open" && rawEyeState === "open";

    if (this.phase === "waiting-to-seek") {
      if (open) {
        this.phase = "seeking";
        this.quietClosedSince = null;
      } else if (closed) {
        this.quietClosedSince ??= now;
        if (now - this.quietClosedSince >= QUIET_REST_MS) this.phase = "resting";
      } else {
        this.quietClosedSince = null;
      }
      return;
    }
    if (["seeking", "found", "resting"].includes(this.phase)) return;

    if (open && this.peekArmed) {
      this.peekArmed = false;
      this.pause("peeking");
      this.react("peek", now, PEEK_REACTION_MS);
      return;
    }
    if (!closed || this.reaction) {
      this.pause(this.reaction?.kind === "peek" || open ? "peeking" : "uncertain");
      return;
    }

    const eligibleBefore = this.previousEligible;
    this.phase = "counting";
    this.pauseReason = null;
    this.peekArmed = true;
    this.previousEligible = true;
    // Both ends must be confirmed closed, with no missing/ambiguous samples between.
    if (eligibleBefore && gap <= MAX_SAMPLE_GAP_MS) {
      this.elapsedMs = Math.min(this.targetMs, this.elapsedMs + gap);
    }
    if (this.elapsedMs >= this.targetMs) {
      this.phase = "waiting-to-seek";
      this.previousEligible = false;
      this.peekArmed = false;
      this.quietClosedSince = now;
      const index = Math.max(0, Math.min(this.spots.length - 1, Math.floor(this.random() * this.spots.length)));
      this.hiddenSpot = this.spots[index];
    }
  }

  suspend() {
    this.active = false;
    this.reaction = null;
    this.facePresent = false;
    this.eyeState = "unknown";
    this.lastObservedAt = null;
    this.faceMissingSince = null;
    this.faceMissingConfirmed = false;
    this.quietClosedSince = null;
    this.peekArmed = false;
    this.pause("inactive");
  }

  resume() {
    this.active = true;
    this.lastObservedAt = null;
    this.previousEligible = false;
  }

  guess(spot) {
    if (!this.active || this.signalStale || this.phase !== "seeking" ||
        !this.facePresent || !this.spots.includes(spot)) return false;
    this.triedSpots.add(spot);
    if (spot !== this.hiddenSpot) {
      this.wrongGuess = spot;
      return false;
    }
    this.phase = "found";
    this.reaction = null;
    this.wrongGuess = null;
    return true;
  }

  nextRound() {
    if (this.phase !== "found" || !this.active) return false;
    this.roundIndex += 1;
    this.resetRound();
    this.lastObservedAt = null;
    return true;
  }
}
