import { MAX_SAMPLE_GAP_MS } from "./game-core.mjs";

export const SENSOR_DEFAULTS = Object.freeze({
  inferenceMs: 250, closedScore: 0.55, openScore: 0.25,
  closedConfirmMs: 500, openConfirmMs: 750, darkLuma: 45,
});

export class EyeTracker {
  constructor(config = SENSOR_DEFAULTS) {
    this.config = { ...SENSOR_DEFAULTS, ...config };
    this.reset();
  }
  reset() {
    this.state = "unknown";
    this.rawState = "unknown";
    this.candidateSince = null;
    this.lastAt = null;
    this.leftBlink = null;
    this.rightBlink = null;
  }
  update(left, right, now) {
    if (this.lastAt !== null && now <= this.lastAt) return this.state;
    if (this.lastAt !== null && now - this.lastAt > MAX_SAMPLE_GAP_MS) this.reset();
    this.lastAt = now;
    this.leftBlink = left;
    this.rightBlink = right;
    let raw = "unknown";
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (left >= this.config.closedScore && right >= this.config.closedScore) raw = "closed";
      else if (left <= this.config.openScore && right <= this.config.openScore) raw = "open";
    }
    if (raw !== this.rawState || raw === "unknown") {
      this.rawState = raw;
      this.candidateSince = raw === "unknown" ? null : now;
      this.state = "unknown";
    }
    if (raw !== "unknown") {
      const required = raw === "closed" ? this.config.closedConfirmMs : this.config.openConfirmMs;
      this.state = now - this.candidateSince >= required ? raw : "unknown";
    }
    return this.state;
  }
}

export function isNight(date = new Date()) {
  const hour = date.getHours();
  return hour >= 21 || hour < 6;
}

export function startMode(lightState, date = new Date()) {
  return isNight(date) ? "night" : lightState;
}

export class LightTracker {
  constructor(threshold = SENSOR_DEFAULTS.darkLuma) {
    this.threshold = threshold;
    this.reset();
  }
  reset() {
    this.active = true;
    this.samples = [];
    this.state = "unknown";
    this.medianLuma = null;
    this.lastAt = null;
  }
  stop() { this.active = false; this.samples = []; }
  observe(luma, now) {
    if (!this.active || !Number.isFinite(luma) || (this.lastAt !== null && now - this.lastAt < 500)) return this.state;
    if (this.lastAt !== null && now - this.lastAt > 1500) this.samples = [];
    this.lastAt = now;
    this.samples.push({ at: now, luma });
    this.samples = this.samples.filter(s => now - s.at <= 3000);
    if (this.samples.length >= 6 && now - this.samples[0].at >= 2500) {
      const sorted = this.samples.map(s => s.luma).sort((a, b) => a - b);
      this.medianLuma = sorted[Math.floor(sorted.length / 2)];
      this.state = this.medianLuma < this.threshold ? "dark" : "light";
    }
    return this.state;
  }
}
