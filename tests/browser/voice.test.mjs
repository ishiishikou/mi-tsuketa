import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
for (const [name, type] of Object.entries({ Chromium: chromium, WebKit: webkit })) {
  test(`${name} voice: all scene and countdown MP3s, gesture playback, mute, background and offline`, async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/mi-tsuketa/`;
    let browser;
    try {
      browser = await type.launch();
      const context = await browser.newContext({viewport:{width:320,height:740}, locale:'ja-JP'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.setFixedTime(new Date('2026-10-20T03:00:00Z'));
      await page.addInitScript(() => {
        window.__audio = {starts:0, stops:0, gum:0};
        const nativeStart = AudioBufferSourceNode.prototype.start;
        const nativeStop = AudioBufferSourceNode.prototype.stop;
        AudioBufferSourceNode.prototype.start = function(...args) { window.__audio.starts++; return nativeStart.apply(this,args); };
        AudioBufferSourceNode.prototype.stop = function(...args) { window.__audio.stops++; return nativeStop.apply(this,args); };
        navigator.mediaDevices.getUserMedia = async () => { window.__audio.gum++; throw Error('unexpected camera'); };
      });
      await page.goto(base);
      for (const animal of ['rabbit','bear','cat']) {
        const prior = await page.evaluate(() => window.__audio.starts);
        await page.locator(`[data-friend="${animal}"]`).click();
        await page.waitForFunction(n => window.__audio.starts > n, prior);
      }
      await page.locator('#voiceToggle').click();
      assert.equal(await page.locator('#voiceToggle').getAttribute('aria-pressed'), 'false');
      const muted = await page.evaluate(() => window.__audio.starts);
      await page.locator('[data-friend="rabbit"]').click();
      assert.equal(await page.evaluate(() => window.__audio.starts), muted);
      await page.locator('#voiceToggle').click();
      await page.locator('[data-friend="rabbit"]').click();
      await page.waitForFunction(n => window.__audio.starts > n, muted);
      const beforeHide = await page.evaluate(() => window.__audio.stops);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      assert.equal(await page.evaluate(() => window.__audio.stops), beforeHide + 1);
      assert.equal(await page.evaluate(() => window.__audio.gum), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // Decode every actual generated file, not a fixture audio payload.
      const decoded = await page.evaluate(async () => {
        const manifest = await (await fetch('./assets/voices/manifest.json')).json();
        const ac = new AudioContext();
        try {
          const results = [];
          for (const clip of manifest.clips) {
            const buffer = await ac.decodeAudioData(await (await fetch('./' + clip.file)).arrayBuffer());
            let peak = 0;
            for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
            results.push({cue:clip.cue,duration:buffer.duration,peak});
          }
          return results;
        } finally { await ac.close(); }
      });
      assert.equal(decoded.length,30);
      for (const clip of decoded) {
        assert.ok(clip.duration > .2 && clip.duration < 9);
        assert.ok(clip.peak > .01 && clip.peak < 1, JSON.stringify(clip));
        if (clip.cue === 'peek') assert.ok(clip.duration < 1.6);
        if (clip.cue === 'returned') assert.ok(clip.duration < .9);
      }
      const countdown = await page.evaluate(async () => {
        const manifest = await (await fetch('./assets/voices/countdown-manifest.json')).json();
        const context = new AudioContext();
        try {
          return await Promise.all(manifest.clips.map(async clip => {
            const response = await fetch('./' + clip.file);
            if (!response.ok) throw new Error('missing ' + clip.file);
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            let peak = 0;
            for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
            return { seconds:clip.remainingSeconds, duration:buffer.duration, peak };
          }));
        } finally { await context.close(); }
      });
      assert.equal(countdown.length,60);
      for (const clip of countdown) {
        assert.ok(clip.peak > .01 && clip.peak < 1);
        assert.ok(clip.duration > .15 && clip.duration < (clip.seconds <= 10 ? 1.05 : 4.5));
      }
      await page.waitForFunction(() => navigator.serviceWorker.controller, null, {timeout:30000});
      // WebKit's setOffline kills even local Service Worker responses:
      // https://github.com/microsoft/playwright/issues/42775
      // Stop the actual origin for both engines. A fresh context without a
      // worker must fail, proving reload/playback cannot fall back to network.
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
      const negative = await browser.newContext({ serviceWorkers: 'block' });
      const uncached = await negative.newPage();
      await assert.rejects(uncached.goto(base, { timeout: 5000 }));
      await negative.close();
      if (name === 'Chromium') await context.setOffline(true);
      await page.reload();
      const prior = await page.evaluate(() => window.__audio.starts);
      await page.locator('[data-friend="cat"]').click();
      await page.waitForFunction(n => window.__audio.starts > n, prior);
      assert.deepEqual(errors, []);
      await page.screenshot({path:`test-results/${name.toLowerCase()}-voice-320.png`});
    } finally {
      await browser?.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  });
}
