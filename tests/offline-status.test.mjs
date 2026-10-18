import test from "node:test";
import assert from "node:assert/strict";
import { OFFLINE_MESSAGES, watchOfflineStatus } from "../offline-status.mjs";

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function createWorker(state = "installing") {
  const worker = new EventTarget();
  worker.state = state;
  worker.move = next => {
    worker.state = next;
    worker.dispatchEvent(new Event("statechange"));
  };
  return worker;
}
function createServiceWorker(registration, { controller = null, reject = false } = {}) {
  const api = new EventTarget();
  api.controller = controller;
  api.register = async () => {
    if (reject) throw new Error("synthetic failure");
    return registration;
  };
  // The .ready promise may remain pending on an initial install failure.
  api.ready = new Promise(() => {});
  return api;
}
function track(sw) {
  const entries = [];
  const stop = watchOfflineStatus(sw, (message, state) => entries.push({ message, state }));
  return { entries, stop, get state() { return entries.at(-1)?.state; } };
}

test("every state has an explicit, distinct Japanese message", () => {
  assert.deepEqual(Object.keys(OFFLINE_MESSAGES).sort(),
    ["unsupported", "installing", "ready", "failed", "update-failed", "waiting"].sort());
  for (const [state, message] of Object.entries(OFFLINE_MESSAGES)) {
    assert.ok(message.length > 8, state);
    assert.equal(typeof message, "string");
  }
});

test("unsupported browser and initial registration rejection never claim ready", async () => {
  const unsupported = track(undefined);
  assert.equal(unsupported.state, "unsupported");
  unsupported.stop();

  const sw = createServiceWorker(null, { reject: true });
  const result = track(sw);
  await flush();
  assert.equal(result.state, "failed");
  result.stop();
});

test("initial install failure is visible even if ready never settles", async () => {
  const worker = createWorker();
  const reg = new EventTarget();
  Object.assign(reg, { installing: worker, waiting: null, active: null });
  const result = track(createServiceWorker(reg));
  await flush();
  assert.equal(result.state, "installing");
  reg.installing = null;
  worker.move("redundant");
  await flush();
  assert.equal(result.state, "failed");
  result.stop();
});

test("active version stays available if register or an update install fails", async () => {
  const rejected = track(createServiceWorker(null, { controller: createWorker("activated"), reject: true }));
  await flush();
  assert.equal(rejected.state, "update-failed");
  rejected.stop();

  const old = createWorker("activated");
  const reg = new EventTarget();
  Object.assign(reg, { installing: null, waiting: null, active: old });
  const sw = createServiceWorker(reg, { controller: old });
  const result = track(sw);
  await flush();
  assert.equal(result.state, "ready");
  const broken = createWorker();
  reg.installing = broken;
  reg.dispatchEvent(new Event("updatefound"));
  await flush();
  reg.installing = null;
  broken.move("redundant");
  await flush();
  assert.equal(result.state, "update-failed");
  // A late ready or controllerchange must not hide a failed update.
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(result.state, "update-failed");
  result.stop();
});

test("waiting wins over ready and a subsequent successful update recovers", async () => {
  const old = createWorker("activated");
  const reg = new EventTarget();
  Object.assign(reg, { installing: null, waiting: null, active: old });
  const sw = createServiceWorker(reg, { controller: old });
  const result = track(sw);
  await flush();

  let next = createWorker();
  reg.installing = next;
  reg.dispatchEvent(new Event("updatefound"));
  reg.waiting = next;
  reg.installing = null;
  next.move("installed");
  await flush();
  assert.equal(result.state, "waiting");
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(result.state, "waiting");

  // A new revision can follow a previous redundant worker.
  reg.waiting = null;
  next.move("redundant");
  assert.equal(result.state, "update-failed");
  next = createWorker();
  reg.installing = next;
  reg.dispatchEvent(new Event("updatefound"));
  assert.equal(result.state, "ready");
  reg.waiting = next;
  reg.installing = null;
  next.move("installed");
  assert.equal(result.state, "waiting");
  reg.waiting = null;
  reg.active = next;
  sw.controller = next;
  next.move("activated");
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(result.state, "ready");
  result.stop();
});

test("stopping the monitor suppresses late async notification", async () => {
  const sw = createServiceWorker(null, { reject: true });
  const result = track(sw);
  result.stop();
  await flush();
  assert.deepEqual(result.entries.map(e => e.state), ["installing"]);
});
