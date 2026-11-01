import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../../scripts/serve.mjs";

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/mi-tsuketa/`;
  await mkdir("test-results", { recursive: true });
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

// All pixels are drawn shapes. No real camera, human face or photograph is used.
async function fixture(browserType, { night = false, dark = false, deny = false, nativeVideoTime = false } = {}) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
  await page.addInitScript(({ dark, deny, nativeVideoTime }) => {
    window.__sensor = { eye: "open", face: true, dark, deny, freeze: false };
    window.__streams = [];
    window.__cameraSessions = [];
    window.__closedDetectors = 0;
    window.__cameraDiagnostics = { startClicks: 0, gumCalls: 0, gumReturns: 0, playStarts: 0, playResolves: 0, playRejects: 0, modelStarts: 0, modelResolves: 0 };
    document.addEventListener("click", event => {
      if (event.target.closest?.("#startButton")) window.__cameraDiagnostics.startClicks++;
    }, true);
    // Observe the native media playback promise; do not fake successful playback.
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.id !== "camera") return nativePlay.apply(this, args);
      const session = window.__cameraSessions[window.__streams.indexOf(this.srcObject)];
      // Observe native presentation, independent of the simulated currentTime
      // used ONLY by deterministic game-state tests. Cancel on track.stop().
      const source = this.srcObject;
      const onFrame = () => {
        if (this.srcObject !== source || source.getVideoTracks()[0].readyState === "ended") return;
        session.frames++;
        session.frameCallback = this.requestVideoFrameCallback(onFrame);
      };
      session.frameCallback = this.requestVideoFrameCallback(onFrame);
      session.playStarts++;
      window.__cameraDiagnostics.playStarts++;
      try {
        return Promise.resolve(nativePlay.apply(this, args)).then(
          value => { session.playResolves++; window.__cameraDiagnostics.playResolves++; return value; },
          error => { session.playRejects++; window.__cameraDiagnostics.playRejects++; throw error; }
        );
      } catch (error) {
        session.playRejects++; window.__cameraDiagnostics.playRejects++;
        throw error;
      }
    };
    const syntheticGetUserMedia = async () => {
      window.__cameraDiagnostics.gumCalls++;
      if (window.__sensor.deny) throw new DOMException("Synthetic denial", "NotAllowedError");
      const session = { paints: 0, frames: 0, inferences: 0, closedDetectors: 0,
        playStarts: 0, playResolves: 0, playRejects: 0, frameCallback: null, timer: null };
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const paint = () => {
        ctx.fillStyle = window.__sensor.dark ? "#101010" : "#d4e6a5";
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = "#e9ad73"; ctx.fillRect(230, 160, 180, 180);
        ctx.fillStyle = "#334b40"; ctx.fillRect(270, 210, 20, 20); ctx.fillRect(350, 210, 20, 20);
        session.paints++;
      };
      paint();
      const stream = canvas.captureStream(15);
      session.timer = setInterval(paint, 100);
      stream.getTracks().forEach(track => {
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(session.timer); session.timer = null;
          if (session.frameCallback !== null) document.querySelector("#camera").cancelVideoFrameCallback(session.frameCallback);
          session.frameCallback = null;
          stop();
        };
      });
      window.__streams.push(stream);
      window.__cameraSessions.push(session);
      window.__cameraDiagnostics.gumReturns++;
      return stream;
    };
    // Cover both access paths; wrapper replacement is not an observed cause.
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia",
      { configurable: true, value: syntheticGetUserMedia });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia",
      { configurable: true, value: syntheticGetUserMedia });
    window.__syntheticGetUserMedia = syntheticGetUserMedia;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    window.__nativeVideoTime = () => descriptor.get.call(document.querySelector("#camera"));
    if (!nativeVideoTime) Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      get() { return this.id === "camera" ? (window.__sensor.freeze ? 0 : performance.now() / 1000) : descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); },
    });
    Math.random = () => 0;
  }, { dark, deny, nativeVideoTime });
  await page.route("**/vendor/vision_bundle.mjs", route => route.fulfill({ contentType: "text/javascript", body: `
    export class FilesetResolver { static async forVisionTasks() { return {}; } }
    export class FaceLandmarker {
      constructor(session) { this.session = session; }
      static async createFromOptions() {
        const session = window.__cameraSessions[window.__streams.indexOf(document.querySelector('#camera').srcObject)];
        window.__cameraDiagnostics.modelStarts++;
        if (window.__sensor.delayModel) await new Promise(resolve => { window.__resolveModel = resolve; });
        window.__cameraDiagnostics.modelResolves++;
        return new FaceLandmarker(session);
      }
      detectForVideo() {
        window.__inferences = (window.__inferences || 0) + 1;
        this.session.inferences++;
        if (!window.__sensor.face) return { faceLandmarks: [], faceBlendshapes: [] };
        const score = window.__sensor.eye === 'closed' ? .9 : window.__sensor.eye === 'open' ? .1 : .4;
        return { faceLandmarks: [[{x:.35,y:.3},{x:.65,y:.7}]], faceBlendshapes: [{categories: [
          {categoryName:'eyeBlinkLeft',score}, {categoryName:'eyeBlinkRight',score}
        ]}] };
      }
      close() { window.__closedDetectors++; this.session.closedDetectors++; }
    }
  ` }));
  const time = new Date(night ? "2026-10-17T12:00:00Z" : "2026-10-17T03:00:00Z");
  if (nativeVideoTime) await page.clock.setFixedTime(time); // Only wall-date is fixed; no time acceleration.
  else await page.clock.install({ time });
  await page.goto(base);
  return { browser, context, page, errors, requests };
}
async function startSyntheticCamera(page) {
  const previousInferences = await page.evaluate(() => window.__inferences ?? 0);
  const previousCalls = await page.evaluate(() => window.__cameraDiagnostics.gumCalls);
  await page.locator("#startButton").click();
  // runFor(5000) advances JS timers, NOT the native media pipeline. The old
  // 50 x runFor(100) loop could expire in ~134ms of real time. Keep the clock
  // running normally until this stream has played, presented fresh frames and
  // supplied its own inference. The real-time deadline remains bounded at 5s.
  const wallStart = performance.now();
  try {
    await page.waitForFunction(({previousInferences, previousCalls}) => {
      const video = document.querySelector("#camera");
      const session = window.__cameraSessions[window.__streams.indexOf(video.srcObject)];
      return window.__cameraDiagnostics.gumCalls > previousCalls &&
        session?.playResolves === 1 && session.frames >= 2 && session.inferences > 0 &&
        video.readyState >= 2 && video.videoWidth > 0 && !video.paused &&
        (window.__inferences ?? 0) > previousInferences;
    }, {previousInferences, previousCalls}, {timeout:5000, polling:50});
  } catch {
    const diagnostics = await page.evaluate(() => {
      const video = document.querySelector("#camera");
      return {
        counters: window.__cameraDiagnostics,
        sessions: window.__cameraSessions,
        nativeVideoTime: window.__nativeVideoTime(),
        inferences: window.__inferences ?? 0,
        cameraMethod: typeof navigator.mediaDevices?.getUserMedia,
        usingMock: navigator.mediaDevices?.getUserMedia === window.__syntheticGetUserMedia,
        startButton: { disabled: document.querySelector("#startButton").disabled, text: document.querySelector("#startButton").textContent },
        currentTrackCount: document.querySelector("#camera").srcObject?.getTracks().length ?? null,
        visibility: document.visibilityState,
        now: performance.now(),
        video: { readyState: video.readyState, paused: video.paused,
          width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null },
        tracks: window.__streams.map(stream => stream.getTracks().map(t => ({readyState:t.readyState, muted:t.muted}))),
        closedDetectors: window.__closedDetectors,
        visible: Object.fromEntries(["welcomeCard", "characterSelect", "resumePanel"].map(
          id => [id, !document.getElementById(id).hidden])),
        message: document.querySelector("#message").textContent,
      };
    });
    assert.fail(`camera startup failed within 5s real time: ${JSON.stringify({ wallMs: Math.round(performance.now() - wallStart), previousInferences, previousCalls, ...diagnostics })}`);
  }
}
async function startAndSampleLight(page) {
  await startSyntheticCamera(page);
  // LightTracker needs several synthetic samples before character selection.
  await page.clock.runFor(3500);
}
async function startAndChoose(page, character = "rabbit", screenshotName = null) {
  await startAndSampleLight(page);
  if (screenshotName) await page.screenshot({ path: `test-results/${screenshotName}-select.png` });
  await page.locator(`[data-character="${character}"]`).click();
  assert.equal(await page.locator("#gameCard").isVisible(), true);
}
const sensor = (page, change) => page.evaluate(change => Object.assign(window.__sensor, change), change);
const elapsed = async page => Number(await page.locator("#gameProgress").getAttribute("aria-valuenow"));

// Exercise the real CSS keyframes at known animation times. A virtual-clock
// delay alone does not guarantee WebKit sampled the same animation frame.
async function checkCelebrationAtWidths(page, browserName) {
  const widths = [320, 390, 414, 430, 499, 500];
  const observe = (stage, currentTime = null) => page.evaluate(({stage, currentTime}) => {
    const card = document.querySelector("#gameCard");
    const friend = document.querySelector("#gameCharacter");
    const forest = document.querySelector(".forest");
    const animation = friend.getAnimations().find(a => a.animationName === "celebrate");
    if (currentTime !== null && animation) {
      animation.pause();
      animation.currentTime = currentTime;
    }
    // Both rectangles and all phase/animation diagnostics are sampled in one
    // layout pass. Never log a camera image, frame or facial landmark.
    const friendRect = friend.getBoundingClientRect();
    const forestRect = forest.getBoundingClientRect();
    const headingRect = document.querySelector("#gameTitle").getBoundingClientRect();
    const centerOffset = (friendRect.left + friendRect.right - forestRect.left - forestRect.right) / 2;
    return {
      stage, viewport: innerWidth, phase: card.dataset.phase, motion: card.dataset.motion, centerOffset,
      scrollY, transform: getComputedStyle(friend).transform,
      opacity: Number(getComputedStyle(friend).opacity), visibility: getComputedStyle(friend).visibility,
      animation: animation ? {state: animation.playState, currentTime: animation.currentTime,
        name: animation.animationName} : null,
      left: getComputedStyle(friend).left,
      forestScroll: {left: forest.scrollLeft, top: forest.scrollTop,
        width: forest.scrollWidth, clientWidth: forest.clientWidth},
      transitions: friend.getAnimations().filter(a => a.transitionProperty).map(a =>
        ({property: a.transitionProperty, state: a.playState, time: a.currentTime})),
      friend: {top: friendRect.top, bottom: friendRect.bottom,
        left: friendRect.left, right: friendRect.right},
      forest: {top: forestRect.top, bottom: forestRect.bottom,
        left: forestRect.left, right: forestRect.right},
      headingTop: headingRect.top,
    };
  }, {stage, currentTime});
  const verify = observation => {
    const detail = JSON.stringify(observation);
    assert.equal(observation.phase, "found", detail);
    assert.ok(observation.opacity >= 0.99 && observation.visibility === "visible",
      `the found friend must be visibly opaque: ${detail}`);
    assert.ok(observation.friend.top >= observation.forest.top,
      `celebrating ears stay inside the scene: ${detail}`);
    assert.ok(observation.friend.bottom <= observation.forest.bottom,
      `celebrating feet stay inside the scene: ${detail}`);
    assert.ok(observation.friend.left >= observation.forest.left &&
      observation.friend.right <= observation.forest.right,
      `celebrating friend stays within the forest horizontally: ${detail}`);
    if (observation.stage === "start" || observation.stage === "after-animation")
      assert.ok(Math.abs(observation.centerOffset) <= 1,
        `the stationary found friend must be centered: ${detail}`);
    assert.ok(observation.headingTop >= 0, `finding a friend keeps its heading on screen: ${detail}`);
    assert.equal(observation.scrollY, 0, `round transitions do not scroll: ${detail}`);
    assert.equal(observation.forestScroll.left, 0, `the decorative scene must not pan horizontally: ${detail}`);
    assert.equal(observation.forestScroll.top, 0, `the decorative scene must not pan vertically: ${detail}`);
  };
  for (const width of widths) {
    await page.setViewportSize({width, height:844});
    const started = await page.evaluate(() => {
      const card = document.querySelector("#gameCard");
      const friend = document.querySelector("#gameCharacter");
      // Restart only the animation. Toggling data-motion also changes width
      // (48% -> 54%) and left (26% -> 23%), creating an artificial transition
      // that can still be sampled on WebKit after returning to "happy".
      // Preserve the real found layout while restarting its CSS keyframes.
      friend.style.animationName = "none";
      void getComputedStyle(friend).animationName;
      friend.style.removeProperty("animation-name");
      void getComputedStyle(friend).animationName;
      // Seeking-to-found also transitions left (300ms) and opacity (200ms).
      // Finish both independent transitions before pausing/restarting the
      // celebration; WebKit's test clock can freeze these at intermediate
      // values. Still assert visible opacity and correct centering below.
      const transitions = friend.getAnimations().filter(a =>
        a.transitionProperty === "opacity" || a.transitionProperty === "left");
      const transitionBefore = transitions.map(t => ({property:t.transitionProperty, state:t.playState, time:t.currentTime}));
      transitions.forEach(t => t.finish());
      const animation = friend.getAnimations().find(a => a.animationName === "celebrate");
      if (animation) {
        animation.pause();
        animation.currentTime = 0;
      }
      return {animation: Boolean(animation), opacity: Number(getComputedStyle(friend).opacity),
        transitionBefore, motion: card.dataset.motion};
    });
    assert.ok(started.animation, `the CSS celebration must exist at ${width}px: ${JSON.stringify(started)}`);
    assert.ok(started.opacity >= 0.99,
      `friend opacity transition must settle before CSS animation probing: ${JSON.stringify(started)}`);
    for (const [stage, ms] of [["start", 0], ["first-apex", 260], ["second-apex", 910]]) {
      const sample = await observe(stage, ms);
      assert.ok(sample.animation, `animation active at ${width}px ${stage}`);
      verify(sample);
      if (stage === "first-apex")
        await page.screenshot({path:`test-results/${browserName}-found-${width}-apex.png`});
    }
    // Playwright's virtual clock can leave CSS animations a few milliseconds
    // shy of their end (on both engines). Seek the real CSSAnimation to its
    // specified endpoint instead of relying on sampling an arbitrary frame.
    await page.evaluate(() => document.querySelector("#gameCharacter")
      .getAnimations().find(a => a.animationName === "celebrate").finish());
    const finished = await observe("after-animation");
    verify(finished);
    assert.notEqual(finished.animation?.state, "running",
      `celebration must stop after both iterations: ${JSON.stringify(finished)}`);
    await page.screenshot({path:`test-results/${browserName}-found-${width}-finished.png`});
    // Verify the illustrated friend remains a real touch target at each
    // viewport, not merely an element whose rectangle is inside the forest.
    const touchTarget = await page.locator("#gameCharacter").boundingBox();
    assert.ok(touchTarget.width >= 44 && touchTarget.height >= 44,
      `found friend is a touch target at ${width}px`);
    await page.locator("#gameCharacter").click();
    assert.equal(await page.locator("#gameCard").getAttribute("data-phase"), "found");
    assert.match(await page.locator("#gameInstruction").innerText(), /なでなで/);
  }
  // Reduced-motion should keep the same bounds without any celebration.
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.setViewportSize({width:499,height:844});
  const reduced = await observe("reduced-motion");
  verify(reduced);
  assert.equal(await page.locator("#gameCharacter").evaluate(el =>
    el.getAnimations().filter(a => a.playState === "running").length), 0,
    "reduced motion does not animate the found character");
  await page.emulateMedia({reducedMotion: "no-preference"});
  await page.setViewportSize({width:390,height:844});
}

for (const [name, type] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name}: decorative forest cannot scroll away from its centered friend`, async t => {
    const f = await fixture(type);
    try {
      // Isolate layout from camera/game logic; use the shipped DOM and CSS.
      await f.page.evaluate(() => {
        document.querySelector("#welcomeCard").hidden = true;
        const card = document.querySelector("#gameCard");
        card.hidden = false; card.dataset.phase = "found"; card.dataset.motion = "happy";
      });
      await f.page.emulateMedia({reducedMotion: "reduce"});
      for (const width of [320, 390, 414, 430, 499, 500]) {
        await f.page.setViewportSize({width, height:844});
        const result = await f.page.evaluate(() => {
          const forest = document.querySelector(".forest"), friend = document.querySelector("#gameCharacter");
          const measure = () => {
            const a = friend.getBoundingClientRect(), b = forest.getBoundingClientRect();
            return {left: forest.scrollLeft, top: forest.scrollTop,
              offset: (a.left + a.right - b.left - b.right) / 2};
          };
          // Diagnostic control: old overflow:hidden allows an 8px internal pan
          // while computed left remains correct. Never reset scroll to pass.
          forest.style.overflow = "hidden";
          forest.scrollTo(8, 8);
          const oldOverflow = measure();
          forest.style.removeProperty("overflow");
          forest.scrollTo(8, 8);
          friend.disabled = false;
          friend.focus(); friend.scrollIntoView({block:"nearest", inline:"nearest"});
          return {oldOverflow, shipped: measure()};
        });
        t.diagnostic(JSON.stringify({width, ...result}));
        assert.equal(result.shipped.left, 0, JSON.stringify(result));
        assert.equal(result.shipped.top, 0, JSON.stringify(result));
        assert.ok(Math.abs(result.shipped.offset) <= 1, JSON.stringify(result));
      }
    } finally { await f.browser.close(); }
  });
  test(`${name}: full round, peek image cleanup, face recovery and next round`, { timeout: 90000 }, async () => {
    const f = await fixture(type);
    const { page } = f;
    try {
      await page.screenshot({ path: `test-results/${name}-welcome.png` });
      await startAndChoose(page, "rabbit", name);
      await page.clock.runFor(300);
      await page.locator("#gameCharacter").click();
      assert.match(await page.locator("#gameInstruction").innerText(), /なでなで/);
      assert.equal(await elapsed(page), 0, "petting never awards closed-eye time");
      await page.clock.runFor(1600);
      await sensor(page, { eye: "closed" });
      await page.clock.runFor(4750);
      const saved = await elapsed(page);
      assert.ok(saved >= 3 && saved <= 4, `saved ${saved}`);
      await sensor(page, { eye: "open" });
      await page.clock.runFor(1100);
      assert.match(await page.locator("#gameInstruction").innerText(), /今見てた/);
      assert.equal(await elapsed(page), saved);
      assert.equal(await page.locator("#peekPhoto").isVisible(), true);
      assert.equal(await page.locator("#gameCharacter .plush").evaluate(el => getComputedStyle(el).backgroundPosition), "50% 50%");
      assert.ok(await page.locator("#peekCanvas").evaluate(canvas => canvas.width > 0));
      await page.screenshot({ path: `test-results/${name}-peek.png` });
      await page.clock.runFor(1800);
      assert.equal(await page.locator("#peekCanvas").evaluate(c => c.width), 0);
      await sensor(page, { eye: "closed" });
      await page.clock.runFor(1750);
      const beforeLoss = await elapsed(page);
      await sensor(page, { face: false });
      await page.clock.runFor(1500);
      assert.match(await page.locator("#gameInstruction").innerText(), /いなくなっちゃった/);
      assert.equal(await elapsed(page), beforeLoss);
      await sensor(page, { face: true });
      await page.clock.runFor(300);
      assert.match(await page.locator("#gameInstruction").innerText(), /あ、いた/);
      await page.clock.runFor(8000);
      assert.equal(await page.locator("#gameCard").getAttribute("data-phase"), "waiting-to-seek");
      assert.match(await page.locator("#gameInstruction").innerText(), /もういいよ！.*めを あけて さがしてね/);
      assert.equal(await page.locator("#peekPhoto").isVisible(), false);
      assert.equal(await page.locator("#gameCard").evaluate(el => el.getAnimations({subtree:true}).filter(a => a.playState === "running").length), 0, "completed closure stays still");
      await sensor(page, { eye: "open" });
      await page.clock.runFor(1100);
      assert.equal(await page.locator("#gameCard").getAttribute("data-phase"), "seeking");
      await page.screenshot({ path: `test-results/${name}-seeking.png` });
      await page.locator('[data-spot="house"]').click();
      assert.match(await page.locator("#guessFeedback").innerText(), /いない/);
      assert.equal(await page.locator('[data-spot="house"] .spot-empty').isVisible(), true);
      await page.locator('[data-spot="tree"]').click();
      // Let the real hidden-to-found opacity transition settle before
      // deliberately seeking the celebration keyframes at each viewport.
      await page.clock.runFor(700);
      await checkCelebrationAtWidths(page, name);
      await page.screenshot({ path: `test-results/${name}-found.png` });
      assert.equal(await page.locator("#foundReward").isVisible(), true);
      assert.equal(await page.locator("#friendFlowers .bloomed").count(), 1);
      await page.locator("#gameCharacter").click();
      assert.match(await page.locator("#gameInstruction").innerText(), /なでなで/);
      assert.equal(await page.locator("#gameCard").getAttribute("data-phase"), "found");
      await page.locator("#nextRoundButton").click();
      assert.equal(await page.locator("#goalSeconds").innerText(), "15");
      assert.equal(await elapsed(page), 0);
      assert.equal(await page.locator("#foundReward").isVisible(), false);
      await page.locator("#endGameButton").click();
      assert.equal(await page.locator("#cameraBubble").isVisible(), false);
      assert.equal(await page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))), true);
      assert.equal(await page.locator("#peekCanvas").evaluate(c => c.width), 0);
      assert.deepEqual(f.errors, []);
      assert.ok(f.requests.every(r => r.method === "GET" && r.url.startsWith(base)));
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    } finally { await f.browser.close(); }
  });

  test(`${name}: storybook friends, small-screen touch targets and reduced motion`, { timeout: 60000 }, async () => {
    const f = await fixture(type);
    const { page } = f;
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({width:320,height:667});
      for (const [animal, greeting] of [["bear", /ぎゅ/], ["rabbit", /ぴょん/], ["cat", /にゃん/]]) {
        await page.locator(`[data-friend="${animal}"]`).click();
        assert.match(await page.locator("#friendGreeting").innerText(), greeting);
        assert.equal(await page.evaluate(() => window.__streams.length), 0, "greeting does not request a camera");
      }
      const decoded = await page.evaluate(async () => {
        const paths = ["rabbit.webp", "bear.webp", "cat.webp", "tree.svg", "house.svg", "flowers.svg"];
        return Promise.all(paths.map(async path => {
          const image = new Image(); image.src = `./assets/${path}`; await image.decode();
          return image.naturalWidth > 0;
        }));
      });
      assert.ok(decoded.every(Boolean), "all character and hiding-place illustrations decode");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path:`test-results/${name}-small.png`});
      await startAndChoose(page, "cat");
      await page.clock.runFor(300);
      assert.equal(await page.locator("#gameCharacter .plush").getAttribute("data-animal"), "cat");
      await page.locator("#gameCharacter").click();
      assert.match(await page.locator("#gameInstruction").innerText(), /ごろごろ/);
      assert.equal(await page.locator("#gameCard").evaluate(el => el.getAnimations({subtree:true}).filter(a => a.playState === "running").length), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("#endGameButton").click();
      await startAndChoose(page, "bear");
      await page.clock.runFor(300);
      await page.locator("#gameCharacter").click();
      assert.match(await page.locator("#gameInstruction").innerText(), /ぽかぽか/);
      await page.locator("#endGameButton").click();
      await startAndSampleLight(page);
      for (const button of await page.locator(".character").all()) {
        const box = await button.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
      }
      await page.screenshot({path:`test-results/${name}-small-select.png`});
      await page.locator("#stopButton").click();
      await page.setViewportSize({width:1280,height:900});
      await page.screenshot({path:`test-results/${name}-desktop.png`});
      assert.deepEqual(f.errors, []);
    } finally { await f.browser.close(); }
  });

  test(`${name}: native video starts, stops and restarts without accelerated time`, { timeout: 60000 }, async t => {
    // Keep the real HTMLMediaElement.currentTime getter. Unlike game-state
    // tests this scenario never calls clock.runFor, so fake timestamps cannot
    // make a stalled video look like a working camera.
    const f = await fixture(type, { nativeVideoTime: true });
    const { page } = f;
    try {
      for (const character of ["cat", "bear", "rabbit"]) {
        await startSyntheticCamera(page);
        await page.waitForFunction(() => !document.querySelector("#characterSelect").hidden,
          null, {timeout:5000});
        await page.locator(`[data-character="${character}"]`).click();
        assert.equal(await page.locator("#gameCard").isVisible(), true);
        const before = await page.evaluate(() => ({ time: document.querySelector("#camera").currentTime,
          frames: window.__cameraSessions.at(-1).frames, inferences: window.__cameraSessions.at(-1).inferences }));
        await page.waitForFunction(before => {
          const session = window.__cameraSessions.at(-1);
          return document.querySelector("#camera").currentTime > before.time &&
            session.frames > before.frames && session.inferences > before.inferences;
        }, before, {timeout:5000, polling:50});
        await page.locator("#endGameButton").click();
        assert.equal(await page.locator("#welcomeCard").isVisible(), true);
        assert.equal(await page.locator("#cameraBubble").isVisible(), false);
        assert.equal(await page.locator("#camera").evaluate(video => video.srcObject), null);
        const stopped = await page.evaluate(() => ({ sessions: window.__cameraSessions,
          tracks: window.__streams.map(stream => stream.getTracks().map(track => track.readyState)) }));
        assert.ok(stopped.tracks.every(tracks => tracks.length === 1 && tracks[0] === "ended"));
        assert.ok(stopped.sessions.every(session => session.closedDetectors === 1 &&
          session.timer === null && session.frameCallback === null && session.playResolves === 1 && session.playRejects === 0));
        // More than one inference interval: the old loop/source must stay dead.
        await delay(350);
        assert.deepEqual(await page.evaluate(() => window.__cameraSessions), stopped.sessions);
        assert.equal(await page.locator("#peekCanvas").evaluate(canvas => canvas.width), 0);
      }
      assert.equal(await page.evaluate(() => window.__streams.length), 3);
      t.diagnostic(JSON.stringify({ browser: name, sessions: await page.evaluate(() => window.__cameraSessions) }));
      assert.deepEqual(f.errors, []);
      assert.ok(f.requests.every(r => r.method === "GET" && r.url.startsWith(base)));
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    } finally { await f.browser.close(); }
  });
}

test("video starvation and page hide retain progress; resume needs new observations", { timeout: 60000 }, async () => {
  const f = await fixture(chromium);
  const { page } = f;
  try {
    await startAndChoose(page);
    await sensor(page, { eye: "closed" });
    await page.clock.runFor(3000);
    await sensor(page, { freeze: true });
    await page.clock.runFor(1000);
    const saved = await elapsed(page);
    await page.clock.runFor(30000);
    assert.equal(await elapsed(page), saved);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(await page.locator("#resumePanel").isVisible(), true);
    assert.equal(await page.locator("#cameraBubble").isVisible(), false);
    await page.clock.runFor(30000);
    assert.equal(await elapsed(page), saved);
    await sensor(page, { freeze: false, eye: "open" });
    await page.locator("#resumeButton").click();
    await page.waitForFunction(() => document.querySelector("#resumePanel").hidden);
    await page.clock.runFor(1500);
    assert.equal(await elapsed(page), saved);
    assert.equal(await page.locator("#peekPhoto").isVisible(), false);
    await sensor(page, { eye: "closed" });
    await page.clock.runFor(2000);
    assert.ok(await elapsed(page) > saved);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

for (const [label, options, expected] of [["night", {night:true}, /夜/], ["dark", {dark:true}, /暗/]]) {
  test(`${label} blocks starting but sleeping characters respond to taps`, { timeout: 60000 }, async () => {
    const f = await fixture(chromium, options);
    try {
      await f.page.locator("#startButton").click();
      await f.page.waitForFunction(() => window.__inferences > 0);
      await f.page.clock.runFor(3500);
      await f.page.locator('[data-character="cat"]').click();
      assert.equal(await f.page.locator("#gameCard").isVisible(), false);
      assert.match(await f.page.locator("#sleepMessage").innerText(), expected);
      if (label === "dark") assert.ok(!(await f.page.locator("#sleepMessage").innerText()).includes("夜"));
      await f.page.screenshot({ path: `test-results/${label}.png` });
      assert.deepEqual(f.errors, []);
    } finally { await f.browser.close(); }
  });
}

test("permission denial can retry without leaked camera resources", { timeout: 60000 }, async () => {
  const f = await fixture(chromium, {deny:true});
  try {
    await f.page.locator("#startButton").click();
    await f.page.waitForFunction(() => document.querySelector("#message").textContent.includes("許可"));
    assert.equal(await f.page.locator("#startButton").isEnabled(), true);
    await sensor(f.page, {deny:false});
    await startAndChoose(f.page);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test("ending during asynchronous model startup closes the late model and camera", { timeout: 60000 }, async () => {
  const f = await fixture(chromium);
  try {
    await sensor(f.page, {delayModel:true});
    await f.page.locator("#startButton").click();
    await f.page.waitForFunction(() => Boolean(window.__resolveModel));
    await f.page.locator("#stopButton").click();
    await f.page.evaluate(() => window.__resolveModel());
    await f.page.waitForFunction(() => window.__closedDetectors === 1);
    assert.equal(await f.page.locator("#cameraBubble").isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test("real MediaPipe loads locally and PWA reloads offline with model assets", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const context = await browser.newContext({ permissions: ["camera"], viewport: {width:390,height:844} });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => requests.push({url:r.url(),method:r.method()}));
    await page.goto(base);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.locator("#startButton").click();
    await page.waitForFunction(() => document.querySelector("#faceBadge").dataset.state === "missing", null, {timeout:45000});
    await page.locator("#stopButton").click();
    await context.setOffline(true);
    await page.reload();
    assert.equal(await page.locator("#startButton").isVisible(), true);
    await page.locator("#startButton").click();
    await page.waitForFunction(() => document.querySelector("#faceBadge").dataset.state === "missing", null, {timeout:45000});
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      return (await Promise.all(keys.map(async k => (await (await caches.open(k)).keys()).map(r => r.url)))).flat();
    });
    assert.ok(cached.some(u => u.endsWith("face_landmarker.task")));
    assert.ok(cached.some(u => u.endsWith("vision_wasm_internal.wasm")));
    for (const asset of ["rabbit.webp", "bear.webp", "cat.webp", "tree.svg", "house.svg", "flowers.svg"]) {
      assert.ok(cached.some(u => u.endsWith(`/assets/${asset}`)), `${asset} is available offline`);
    }
    assert.equal(await page.evaluate(async () => {
      const image = new Image(); image.src = "./assets/rabbit.webp"; await image.decode(); return image.naturalWidth > 0;
    }), true);
    assert.ok(cached.every(u => u.startsWith(base) && !/blob:|data:|peek|camera/.test(u)));
    assert.ok(requests.every(r => r.method === "GET" && r.url.startsWith(base)));
    assert.deepEqual(errors, []);
    await page.locator("#stopButton").click();
  } finally { await browser.close(); }
});
