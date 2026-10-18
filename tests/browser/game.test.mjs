import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
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
async function fixture(browserType, { night = false, dark = false, deny = false } = {}) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
  await page.addInitScript(({ dark, deny }) => {
    window.__sensor = { eye: "open", face: true, dark, deny, freeze: false };
    window.__streams = [];
    window.__closedDetectors = 0;
    window.__cameraDiagnostics = { gumCalls: 0, gumReturns: 0, playStarts: 0, playResolves: 0, playRejects: 0, modelStarts: 0, modelResolves: 0 };
    // Observe the native media playback promise; do not fake successful playback.
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.id !== "camera") return nativePlay.apply(this, args);
      window.__cameraDiagnostics.playStarts++;
      try {
        return Promise.resolve(nativePlay.apply(this, args)).then(
          value => { window.__cameraDiagnostics.playResolves++; return value; },
          error => { window.__cameraDiagnostics.playRejects++; throw error; }
        );
      } catch (error) {
        window.__cameraDiagnostics.playRejects++;
        throw error;
      }
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      window.__cameraDiagnostics.gumCalls++;
      if (window.__sensor.deny) throw new DOMException("Synthetic denial", "NotAllowedError");
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const paint = () => {
        ctx.fillStyle = window.__sensor.dark ? "#101010" : "#d4e6a5";
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = "#e9ad73"; ctx.fillRect(230, 160, 180, 180);
        ctx.fillStyle = "#334b40"; ctx.fillRect(270, 210, 20, 20); ctx.fillRect(350, 210, 20, 20);
      };
      paint();
      const stream = canvas.captureStream(15);
      const timer = setInterval(paint, 100);
      stream.getTracks().forEach(track => {
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      });
      window.__streams.push(stream);
      window.__cameraDiagnostics.gumReturns++;
      return stream;
    } });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      get() { return this.id === "camera" ? (window.__sensor.freeze ? 0 : performance.now() / 1000) : descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); },
    });
    Math.random = () => 0;
  }, { dark, deny });
  await page.route("**/vendor/vision_bundle.mjs", route => route.fulfill({ contentType: "text/javascript", body: `
    export class FilesetResolver { static async forVisionTasks() { return {}; } }
    export class FaceLandmarker {
      static async createFromOptions() {
        window.__cameraDiagnostics.modelStarts++;
        if (window.__sensor.delayModel) await new Promise(resolve => { window.__resolveModel = resolve; });
        window.__cameraDiagnostics.modelResolves++;
        return new FaceLandmarker();
      }
      detectForVideo() {
        window.__inferences = (window.__inferences || 0) + 1;
        if (!window.__sensor.face) return { faceLandmarks: [], faceBlendshapes: [] };
        const score = window.__sensor.eye === 'closed' ? .9 : window.__sensor.eye === 'open' ? .1 : .4;
        return { faceLandmarks: [[{x:.35,y:.3},{x:.65,y:.7}]], faceBlendshapes: [{categories: [
          {categoryName:'eyeBlinkLeft',score}, {categoryName:'eyeBlinkRight',score}
        ]}] };
      }
      close() { window.__closedDetectors++; }
    }
  ` }));
  await page.clock.install({ time: new Date(night ? "2026-10-17T12:00:00Z" : "2026-10-17T03:00:00Z") });
  await page.goto(base);
  return { browser, context, page, errors, requests };
}
async function startSyntheticCamera(page) {
  const previousInferences = await page.evaluate(() => window.__inferences ?? 0);
  await page.locator("#startButton").click();
  // WebKit can await a fresh canvas frame in video.play() while the test clock is
  // paused. Drive synthetic frame delivery *while* awaiting this session's first
  // inference, rather than waiting for inference before advancing the clock.
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    await page.clock.runFor(100);
    ready = await page.evaluate(previous => (window.__inferences ?? 0) > previous, previousInferences);
    if (ready) break;
  }
  if (!ready) {
    const diagnostics = await page.evaluate(() => {
      const video = document.querySelector("#camera");
      return {
        counters: window.__cameraDiagnostics,
        inferences: window.__inferences ?? 0,
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
    assert.fail(`synthetic camera did not infer in 5s of driven clock: ${JSON.stringify(diagnostics)}`);
  }
  // LightTracker needs several synthetic samples before character selection.
  await page.clock.runFor(3500);
}
async function startAndChoose(page, character = "rabbit", screenshotName = null) {
  await startSyntheticCamera(page);
  if (screenshotName) await page.screenshot({ path: `test-results/${screenshotName}-select.png` });
  await page.locator(`[data-character="${character}"]`).click();
  assert.equal(await page.locator("#gameCard").isVisible(), true);
}
const sensor = (page, change) => page.evaluate(change => Object.assign(window.__sensor, change), change);
const elapsed = async page => Number(await page.locator("#gameProgress").getAttribute("aria-valuenow"));

for (const [name, type] of [["Chromium", chromium], ["WebKit", webkit]]) {
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
      assert.equal(await page.locator("#gameInstruction").innerText(), "…");
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
      await page.clock.runFor(700);
      const friendBox = await page.locator("#gameCharacter").boundingBox();
      const forestBox = await page.locator(".forest").boundingBox();
      assert.ok(friendBox.y >= forestBox.y, "celebrating ears stay inside the scene");
      assert.ok((await page.locator("#gameTitle").boundingBox()).y >= 0, "finding a friend keeps its heading on screen");
      assert.equal(await page.evaluate(() => scrollY), 0, "round transitions return to the top without scroll anchoring");
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
      await startSyntheticCamera(page);
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
