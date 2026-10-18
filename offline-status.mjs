/**
 * Read-only Service Worker status reporting. Never interrupts gameplay or
 * forces a waiting version to activate while an older page is open.
 */
export const OFFLINE_MESSAGES = Object.freeze({
  unsupported: "このブラウザではオフラインの準備ができません。オンラインで遊べます。",
  installing: "オフラインの準備中…",
  ready: "オフラインの準備ができました。",
  failed: "オフラインの準備ができませんでした。接続して開き直してください。",
  "update-failed": "今の版は使えます。更新の準備ができなかったので、接続して開き直してください。",
  waiting: "新しい版の準備ができました。あそび終えたら、開いているアプリとタブをすべて閉じて開き直してください。",
});

/**
 * @param {ServiceWorkerContainer|undefined} serviceWorker
 * @param {(message:string, state:string)=>void} report
 * @returns {()=>void} Removes observation listeners.
 */
export function watchOfflineStatus(serviceWorker, report) {
  const listeners = [];
  const observed = new WeakSet();
  let registration = null;
  let failed = false;
  let stopped = false;
  let shown = null;

  function publish(state) {
    if (!stopped && shown !== state) {
      shown = state;
      report(OFFLINE_MESSAGES[state], state);
    }
  }
  function workingVersion() {
    return Boolean(serviceWorker?.controller || registration?.active);
  }
  function refresh() {
    if (!serviceWorker?.register) return publish("unsupported");
    // A waiting worker must take precedence over later ready notifications.
    if (registration?.waiting) return publish("waiting");
    // A failed update must not be overwritten by navigator.serviceWorker.ready.
    if (failed) return publish(workingVersion() ? "update-failed" : "failed");
    if (workingVersion()) return publish("ready");
    publish("installing");
  }
  function listen(target, event, callback) {
    target?.addEventListener?.(event, callback);
    listeners.push(() => target?.removeEventListener?.(event, callback));
  }
  function watch(worker) {
    if (!worker || observed.has(worker)) return;
    observed.add(worker);
    const changed = () => {
      if (worker.state === "redundant") failed = true;
      refresh();
      // The Registration's installing/waiting pointer may change after the
      // worker's event is emitted, so reconcile again in a microtask.
      queueMicrotask(refresh);
    };
    listen(worker, "statechange", changed);
    listen(worker, "error", () => { failed = true; refresh(); });
    if (worker.state === "redundant") changed();
  }

  if (!serviceWorker?.register) {
    publish("unsupported");
    return () => { stopped = true; };
  }
  publish("installing");
  listen(serviceWorker, "controllerchange", refresh);
  // Keep the promise separate from .ready: ready can remain pending indefinitely
  // when the very first install fails.
  Promise.resolve().then(() => serviceWorker.register("./sw.js")).then(reg => {
    if (stopped) return;
    registration = reg;
    listen(reg, "updatefound", () => {
      failed = false; // a *new* install attempt supersedes an earlier failure
      watch(reg.installing);
      refresh();
    });
    watch(reg.installing);
    watch(reg.waiting);
    if (!reg.active && !reg.installing && !reg.waiting && !serviceWorker.controller) {
      failed = true; // register resolved with no viable worker
    }
    refresh();
    Promise.resolve(serviceWorker.ready).then(() => {
      if (!stopped) refresh();
    }, () => {
      failed = true;
      refresh();
    });
  }, () => {
    failed = true;
    refresh();
  });

  return () => {
    stopped = true;
    for (const remove of listeners) remove();
  };
}
