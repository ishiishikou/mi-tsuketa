import test from "node:test";
import assert from "node:assert/strict";
import { HideAndSeekGame, ROUND_SECONDS, PEEK_REACTION_MS, QUIET_REST_MS } from "../game-core.mjs";
import { EyeTracker } from "../sensing.mjs";

const see = (g, now, eyeState = "closed", facePresent = true, rawEyeState = eyeState) =>
  g.observe({ facePresent, eyeState, rawEyeState }, now);
const closed = (g, from, to) => { for (let t = from; t <= to; t += 250) see(g, t); };

test("4 seconds are retained through a peek and reaction, then 6 seconds finish the round", () => {
  const g = new HideAndSeekGame({ random: () => 0 });
  closed(g, 0, 4000);
  assert.equal(g.elapsedMs, 4000);
  see(g, 4250, "open");
  const id = g.reaction.id;
  assert.equal(g.phase, "paused");
  assert.equal(g.remainingSeconds, 6);
  for (let t = 4500; t < 4250 + PEEK_REACTION_MS; t += 250) see(g, t);
  assert.equal(g.elapsedMs, 4000, "closing during the reaction earns no time");
  assert.equal(g.reaction.id, id);
  closed(g, 6000, 12000);
  assert.equal(g.elapsedMs, 10000);
  assert.equal(g.phase, "waiting-to-seek");
  assert.equal(g.hiddenSpot, "tree");
});

test("sustained open eyes react only once, but a new peek after resuming reacts again", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 1000);
  for (let t = 1250; t <= 5000; t += 250) see(g, t, "open");
  assert.equal(g.reactionSequence, 1);
  assert.equal(g.elapsedMs, 1000);
  closed(g, 5250, 6250);
  see(g, 6500, "open");
  assert.equal(g.reactionSequence, 2);
  assert.equal(g.elapsedMs, 2000);
});

test("opening candidate/uncertain eyes pause before open confirmation, even at the deadline", () => {
  const g = new HideAndSeekGame({ roundSeconds: [1] });
  closed(g, 0, 750);
  see(g, 1000, "closed", true, "open");
  assert.equal(g.phase, "paused");
  assert.equal(g.elapsedMs, 750);
  see(g, 1250, "unknown");
  see(g, 1500, "open");
  assert.equal(g.reaction.kind, "peek");
  assert.equal(g.hiddenSpot, null);
});

test("a 250ms blink never starts a round, and a brief opening during counting does not react", () => {
  const g = new HideAndSeekGame();
  const tracker = new EyeTracker();
  const frame = (t, score) => {
    tracker.update(score, score, t);
    see(g, t, tracker.state, true, tracker.rawState);
  };
  for (let t = 0; t <= 1000; t += 250) frame(t, 0.1);
  frame(1250, 0.9);
  frame(1500, 0.1);
  assert.equal(g.phase, "ready");
  for (let t = 1750; t <= 3500; t += 250) frame(t, 0.9);
  const saved = g.elapsedMs;
  frame(3750, 0.1);
  frame(4000, 0.9);
  frame(4250, 0.9);
  frame(4500, 0.9);
  assert.equal(g.reactionSequence, 0);
  assert.equal(g.elapsedMs, saved);
  frame(4750, 0.9);
  assert.equal(g.elapsedMs, saved + 250);
});

test("short detection loss pauses quietly and preserves progress", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 1500);
  see(g, 1750, "unknown", false);
  g.tick(1950);
  assert.equal(g.faceMissingConfirmed, false);
  assert.equal(g.elapsedMs, 1500);
  see(g, 2000, "unknown");
  see(g, 2250);
  see(g, 2500);
  assert.equal(g.elapsedMs, 1750);
  assert.equal(g.reactionSequence, 0);
});

test("confirmed face loss and return never award missing time or falsely accuse peeking", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 2000);
  for (let t = 2250; t <= 5000; t += 250) see(g, t, "unknown", false);
  assert.equal(g.faceMissingConfirmed, true);
  assert.equal(g.elapsedMs, 2000);
  see(g, 5250, "open");
  assert.equal(g.reaction.kind, "returned");
  closed(g, 5500, 6000);
  assert.equal(g.elapsedMs, 2000);
  closed(g, 6250, 7250);
  assert.equal(g.elapsedMs, 3000);
});

test("completion survives lost face; later opening is seeking, not a peek", () => {
  const g = new HideAndSeekGame({ roundSeconds: [1], random: () => 0 });
  closed(g, 0, 1000);
  for (let t = 1250; t <= 3000; t += 250) see(g, t, "unknown", false);
  assert.equal(g.phase, "waiting-to-seek");
  assert.equal(g.hiddenSpot, "tree");
  see(g, 3250, "open");
  assert.equal(g.phase, "seeking");
  assert.equal(g.reaction, null);
  assert.equal(g.guess("tree"), true);
});

test("RAF ticks and a frozen video cannot count stale closed-eye observations", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 1000);
  for (let t = 1016; t <= 91000; t += 16) g.tick(t);
  assert.equal(g.elapsedMs, 1000);
  assert.equal(g.signalStale, true);
  see(g, 91500);
  assert.equal(g.elapsedMs, 1000);
  see(g, 91750);
  assert.equal(g.elapsedMs, 1250);
});

test("a long callback gap is discarded entirely, rather than clamped into free time", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 500);
  see(g, 90000);
  assert.equal(g.elapsedMs, 500);
  see(g, 90250);
  assert.equal(g.elapsedMs, 750);
});

test("hidden-tab and resume discard old eye state, reaction and the unobserved interval", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 1000);
  g.tick(1100, false);
  see(g, 90000);
  assert.equal(g.elapsedMs, 1000);
  assert.equal(g.active, false);
  g.resume();
  see(g, 90250, "unknown");
  see(g, 90500);
  assert.equal(g.elapsedMs, 1000);
  see(g, 90750);
  assert.equal(g.elapsedMs, 1250);
});

test("duplicate/backward timestamps do not count or introduce false reactions", () => {
  const g = new HideAndSeekGame();
  closed(g, 0, 1000);
  see(g, 1000, "open");
  see(g, 900, "open");
  assert.equal(g.elapsedMs, 1000);
  assert.equal(g.reaction, null);
});

test("wrong choices can be retried elsewhere, success alone advances the duration", () => {
  const g = new HideAndSeekGame({ roundSeconds: [1, 2], random: () => 0 });
  assert.equal(g.nextRound(), false);
  closed(g, 0, 1000);
  assert.equal(g.guess("tree"), false);
  see(g, 1250, "open");
  assert.equal(g.guess("invalid"), false);
  assert.equal(g.guess("house"), false);
  assert.equal(g.triedSpots.has("house"), true);
  assert.equal(g.guess("tree"), true);
  assert.equal(g.nextRound(), true);
  assert.equal(g.targetMs, 2000);
  assert.equal(g.elapsedMs, 0);
  assert.equal(g.triedSpots.size, 0);
});

test("all six duration steps are reachable and cap at 60 seconds", () => {
  const g = new HideAndSeekGame({ random: () => 0 });
  assert.deepEqual(ROUND_SECONDS, [10, 15, 20, 30, 45, 60]);
  let t = 0;
  for (const seconds of [10, 15, 20, 30, 45, 60, 60]) {
    assert.equal(g.targetMs, seconds * 1000);
    closed(g, t, t + seconds * 1000);
    t += seconds * 1000 + 250;
    see(g, t, "open");
    assert.equal(g.guess("tree"), true);
    assert.equal(g.nextRound(), true);
    t += 250;
  }
});

test("quiet waiting makes no reaction, then rests after one further minute of observed closure", () => {
  const g = new HideAndSeekGame({ roundSeconds: [1] });
  closed(g, 0, 1000);
  closed(g, 1250, 1000 + QUIET_REST_MS - 250);
  assert.equal(g.phase, "waiting-to-seek");
  see(g, 1000 + QUIET_REST_MS);
  assert.equal(g.phase, "resting");
  assert.equal(g.reactionSequence, 0);
});
