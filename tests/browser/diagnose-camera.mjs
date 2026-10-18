// Standalone, synthetic-only differential probe for Issue #17. No app/model is
// loaded. Native media playback is never mocked; only scalar lifecycle data is
// printed. A failed observation is data, not a retried/passing regression test.
import { webkit } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

for (const mode of ["virtual-auto", "virtual-request-frame", "virtual-real-gate", "real-auto"]) {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 667 } });
    if (mode !== "real-auto") await page.clock.install();
    await page.setContent('<video id="camera" autoplay muted playsinline width="72" height="90"></video>');
    for (let session = 1; session <= 3; session++) {
      await page.evaluate(mode => {
        const video = document.querySelector("video");
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 480;
        const ctx = canvas.getContext("2d");
        const state = window.probe = { paints: 0, frames: 0, play: "pending", events: [] };
        const events = ["loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "emptied", "error"];
        const onEvent = event => state.events.push(event.type);
        events.forEach(event => video.addEventListener(event, onEvent));
        let track;
        const paint = () => {
          ctx.fillStyle = "#d4e6a5"; ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = "#e9ad73"; ctx.fillRect(230, 160, 180, 180);
          ctx.fillStyle = "#334b40"; ctx.fillRect(270, 210, 20, 20); ctx.fillRect(350, 210, 20, 20);
          state.paints++;
          if (mode === "virtual-request-frame") track?.requestFrame();
        };
        paint();
        const stream = canvas.captureStream(mode === "virtual-request-frame" ? 0 : 15);
        track = stream.getVideoTracks()[0];
        const timer = setInterval(paint, 100);
        let callback;
        const frame = () => { state.frames++; callback = video.requestVideoFrameCallback(frame); };
        if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(frame);
        video.srcObject = stream;
        video.play().then(() => { state.play = "resolved"; }, error => { state.play = error.name; });
        window.observe = () => ({ ...state, readyState: video.readyState, paused: video.paused,
          width: video.videoWidth, time: video.currentTime, clock: performance.now(),
          track: track.readyState, muted: track.muted });
        window.cleanup = () => {
          clearInterval(timer); track.stop(); video.srcObject = null;
          if (callback !== undefined) video.cancelVideoFrameCallback(callback);
          events.forEach(event => video.removeEventListener(event, onEvent));
        };
      }, mode);
      const start = performance.now();
      let observation;
      for (let tick = 0; tick < 50; tick++) {
        if (mode === "virtual-auto" || mode === "virtual-request-frame") await page.clock.runFor(100);
        else await delay(100);
        observation = await page.evaluate(() => window.observe());
        if (observation.play === "resolved" && observation.readyState >= 2 && observation.frames >= 2) break;
      }
      console.log(JSON.stringify({ mode, session, phase: "initial", wallMs: Math.round(performance.now() - start), ...observation }));
      if (observation.play !== "resolved" || observation.readyState < 2 || observation.frames < 2) {
        const recoverStart = performance.now();
        for (let tick = 0; tick < 50; tick++) {
          await delay(100);
          observation = await page.evaluate(() => window.observe());
          if (observation.play === "resolved" && observation.readyState >= 2 && observation.frames >= 2) break;
        }
        console.log(JSON.stringify({ mode, session, phase: "real-time-observation", wallMs: Math.round(performance.now() - recoverStart), ...observation }));
      }
      if (mode !== "real-auto") await page.clock.runFor(3500);
      await page.evaluate(() => window.cleanup());
    }
  } finally { await browser.close(); }
}
