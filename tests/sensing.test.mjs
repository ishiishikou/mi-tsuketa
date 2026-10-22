import test from "node:test";
import assert from "node:assert/strict";
import { EyeTracker, LightTracker, startMode, isNight } from "../sensing.mjs";
import { CHARACTERS, NIGHT_MESSAGE, gamePresentation } from "../characters.mjs";
import { HideAndSeekGame } from "../game-core.mjs";

test("eyes require sustained agreement from both eyes and reset on ambiguous or missing values", () => {
  const e = new EyeTracker();
  assert.equal(e.update(.9, .9, 0), "unknown");
  assert.equal(e.update(.9, .9, 250), "unknown");
  assert.equal(e.update(.9, .9, 500), "closed");
  assert.equal(e.update(.9, .1, 750), "unknown");
  assert.equal(e.update(.1, .1, 1000), "unknown");
  e.update(.1, .1, 1250); e.update(.1, .1, 1500);
  assert.equal(e.update(.1, .1, 1750), "open");
  assert.equal(e.update(null, .1, 2000), "unknown");
  assert.equal(e.update(NaN, .1, 2250), "unknown");
});

test("eye confirmation cannot bridge camera starvation or tab suspension", () => {
  const e = new EyeTracker();
  e.update(.9, .9, 0);
  assert.equal(e.update(.9, .9, 90000), "unknown");
  e.update(.9, .9, 90250);
  assert.equal(e.update(.9, .9, 90500), "closed");
  e.reset();
  assert.equal(e.update(.9, .9, 91000), "unknown");
});

for (const [hour, minute, night] of [[20,59,false],[21,0,true],[23,59,true],[0,0,true],[5,59,true],[6,0,false]]) {
  test(`night boundary ${hour}:${minute} = ${night}`, () => {
    const d = new Date(2026, 9, 17, hour, minute);
    assert.equal(isNight(d), night);
    assert.equal(startMode("light", d), night ? "night" : "light");
    assert.equal(startMode("dark", d), night ? "night" : "dark");
  });
}

test("light needs 2.5+ seconds of samples and ignores a hand covering one frame", () => {
  const l = new LightTracker();
  for (let t = 0; t < 2500; t += 500) assert.equal(l.observe(t === 1500 ? 0 : 120, t), "unknown");
  assert.equal(l.observe(120, 2500), "light");
  for (let t = 3000; t <= 6500; t += 500) l.observe(10, t);
  assert.equal(l.state, "dark");
  l.stop();
  for (let t = 7000; t <= 12000; t += 500) l.observe(250, t);
  assert.equal(l.state, "dark", "no measurement changes after game start");
});

test("light threshold is configurable and a long gap cannot reuse old samples", () => {
  const l = new LightTracker(60);
  for (let t = 0; t <= 2000; t += 500) l.observe(50, t);
  assert.equal(l.observe(50, 90000), "unknown");
  for (let t = 90500; t <= 92500; t += 500) l.observe(50, t);
  assert.equal(l.state, "dark");
});

test("all characters have complete reactions, with daylight darkness distinct from night", () => {
  for (const [key, c] of Object.entries(CHARACTERS)) {
    for (const field of ["name", "greeting", "pet", "ready", "peek", "returned", "found", "dark"]) assert.ok(c[field]);
    assert.ok(!c.dark.includes("夜"));
    const g = new HideAndSeekGame();
    assert.equal(gamePresentation(g, key).text, c.ready);
    g.phase = "waiting-to-seek";
    assert.equal(gamePresentation(g, key).quiet, true);
    g.faceMissingConfirmed = true;
    assert.match(gamePresentation(g, key).text, /もういいよ！.*めを あけて/, "waiting tells the child when to open eyes");
  }
  assert.match(NIGHT_MESSAGE, /夜/);
});
