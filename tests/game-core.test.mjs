import test from "node:test";
import assert from "node:assert/strict";
import { HideAndSeekGame, ROUND_SECONDS } from "../game-core.mjs";

const observe = (game, facePresent, eyeState, time) =>
  game.observe({ facePresent, eyeState }, time);

test("progress needs continuously detected closed eyes, not a blink", () => {
  const game = new HideAndSeekGame({ roundSeconds: [1], spots: ["tree"], random: () => 0 });
  observe(game, true, "closed", 0);
  game.tick(500);
  observe(game, true, "open", 600);
  assert.equal(game.phase, "ready");
  assert.equal(game.elapsedMs, 0);
  observe(game, true, "closed", 650);
  game.tick(1150);
  assert.equal(game.phase, "counting");
  game.tick(1650);
  assert.equal(game.phase, "waiting-to-seek");
  assert.equal(game.remainingSeconds, 0);
  assert.equal(game.guess("tree"), false);
  observe(game, true, "open", 1700);
  assert.equal(game.phase, "seeking");
  assert.equal(game.guess("tree"), true);
  assert.equal(game.phase, "found");
});

test("lost face cancels eye timer and does not award time", () => {
  const game = new HideAndSeekGame({ roundSeconds: [2] });
  observe(game, true, "closed", 0);
  game.tick(500);
  observe(game, false, "unknown", 600);
  assert.equal(game.phase, "ready");
  assert.equal(game.elapsedMs, 0);
  game.tick(1100);
  assert.equal(game.elapsedMs, 0);
});

test("a hidden or throttled tab cannot complete a round", () => {
  const game = new HideAndSeekGame({ roundSeconds: [10] });
  observe(game, true, "closed", 0);
  game.tick(500);
  game.tick(90000, false);
  game.tick(90100);
  assert.ok(game.elapsedMs < 1000);
});

test("wrong guesses remain retryable and round duration increases", () => {
  const game = new HideAndSeekGame({ roundSeconds: [1, 2], spots: ["tree", "house"], random: () => 0 });
  observe(game, true, "closed", 0);
  game.tick(1000);
  observe(game, true, "open", 1100);
  assert.equal(game.guess("house"), false);
  assert.equal(game.phase, "seeking");
  assert.equal(game.guess("tree"), true);
  assert.equal(game.nextRound(1200), true);
  assert.equal(game.targetMs, 2000);
  assert.equal(game.nextRound(1300), false);
});

test("round duration caps at the longest configured step", () => {
  const game = new HideAndSeekGame();
  assert.deepEqual(ROUND_SECONDS, [10, 15, 20, 30, 45, 60]);
  game.roundIndex = 20;
  assert.equal(game.targetMs, 60000);
});
