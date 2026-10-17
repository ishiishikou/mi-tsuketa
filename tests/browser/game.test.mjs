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
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
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
        if (window.__sensor.delayModel) await new Promise(resolve => { window.__resolveModel = resolve; });
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
async function startAndChoose(page) {
  await page.locator("#startButton").click();
  await page.waitForFunction(() => window.__inferences > 0);
  await page.clock.runFor(3500);
  await page.locator('[data-character="rabbit"]').click();
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
      await startAndChoose(page);
      await sensor(page, { eye: "closed" });
      await page.clock.runFor(4750);
      const saved = await elapsed(page);
      assert.ok(saved >= 3 && saved <= 4, `saved ${saved}`);
      await sensor(page, { eye: "open" });
      await page.clock.runFor(1100);
      assert.match(await page.locator("#gameInstruction").innerText(), /今見てた/);
      assert.equal(await elapsed(page), saved);
      assert.equal(await page.locator("#peekPhoto").isVisible(), true);
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
      await sensor(page, { eye: "open" });
      await page.clock.runFor(1100);
      assert.equal(await page.locator("#gameCard").getAttribute("data-phase"), "seeking");
      await page.locator('[data-spot="house"]').click();
      assert.match(await page.locator("#guessFeedback").innerText(), /いない/);
      await page.locator('[data-spot="tree"]').click();
      await page.screenshot({ path: `test-results/${name}-found.png` });
      await page.locator("#nextRoundButton").click();
      assert.equal(await page.locator("#goalSeconds").innerText(), "15");
      assert.equal(await elapsed(page), 0);
      await page.locator("#endGameButton").click();
      assert.equal(await page.locator("#cameraBubble").isVisible(), false);
      assert.equal(await page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))), true);
      assert.equal(await page.locator("#peekCanvas").evaluate(c => c.width), 0);
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
    assert.ok(cached.every(u => u.startsWith(base) && !/blob:|data:|peek|camera/.test(u)));
    assert.ok(requests.every(r => r.method === "GET" && r.url.startsWith(base)));
    assert.deepEqual(errors, []);
    await page.locator("#stopButton").click();
  } finally { await browser.close(); }
});
