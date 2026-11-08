/* Local, bounded aggregate diagnostics. This module never stores event details. */
(() => {
  const KEY = "craigZoneDiagnosticsV1";
  const ACTIONS = ["switches", "mutes", "starts", "stops", "fullscreen", "edits"];
  const FAILURES = ["start", "switch", "mute", "stop", "fullscreen", "edit"];
  const manifest = browser.runtime.getManifest?.() || {};
  const BUILD = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(manifest.version || "") ? manifest.version : null;
  const BROWSER = browser.runtime.getURL?.("")?.startsWith("chrome-extension:") ? "chromium" : browser.runtime.getURL?.("")?.startsWith("moz-extension:") ? "firefox" : "unknown";
  const nativeEnabled = !manifest.permissions || manifest.permissions.includes("nativeMessaging");
  let mirrorStatus = nativeEnabled ? "pending" : "disabled";
  let lastMirrorAt = null;
  let storageAvailable = true;
  const DAY_MS = 86400000;
  let pending = null;
  let writeTimer = null;
  let pruneTimer = null;
  let lastWrite = 0;
  let state = null;
  let storageChain = Promise.resolve();
  let mirrorChain = Promise.resolve();

  function day(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }
  function blank() { return { version: 2, days: {}, updatedAt: null }; }
  function clean(raw, today) {
    const result = blank();
    if (!raw || ![1, 2].includes(raw.version) || !raw.days || typeof raw.days !== "object" || Array.isArray(raw.days)) return result;
    if (typeof raw.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(raw.updatedAt) && Number.isFinite(Date.parse(raw.updatedAt))) result.updatedAt = raw.updatedAt;
    const cutoff = Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS;
    for (const [key, value] of Object.entries(raw.days)) {
      const stamp = Date.parse(`${key}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== key || stamp < cutoff || stamp > Date.parse(`${today}T00:00:00Z`) || !value || typeof value !== "object") continue;
      const row = { actions: Object.fromEntries(ACTIONS.map((name) => [name, 0])), failures: Object.fromEntries(FAILURES.map((name) => [name, 0])),
        builds: [...new Set((raw.version === 1 ? ["unknown"] : Array.isArray(value.builds) ? value.builds : []).filter((v) => v === "unknown" || typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)))].slice(0, 4),
        browsers: [...new Set((raw.version === 1 ? ["unknown"] : Array.isArray(value.browsers) ? value.browsers : []).filter((v) => ["chromium", "firefox", "unknown"].includes(v)))],
        sessionSizes: {}, permissions: {} };
      for (const [field, keys] of [["sessionSizes", ["1","2","3","4","5","6","7","8","9"]], ["permissions", ["granted", "denied", "failed"]]]) {
        for (const key of keys) {
          const count = value[field]?.[key];
          if (Number.isSafeInteger(count) && count >= 0) row[field][key] = Math.min(count, 1000000);
        }
      }
      for (const name of ACTIONS) {
        const count = value.actions?.[name];
        if (Number.isSafeInteger(count) && count >= 0) row.actions[name] = Math.min(count, 1000000);
      }
      for (const name of FAILURES) {
        const count = value.failures?.[name];
        if (Number.isSafeInteger(count) && count >= 0) row.failures[name] = Math.min(count, 1000000);
      }
      result.days[key] = row;
    }
    return result;
  }
  async function readStored() {
    try {
      const stored = await browser.storage.local.get(KEY);
      return clean(stored?.[KEY], day());
    } catch (_) { storageAvailable = false; return blank(); }
  }
  function queueMirror(snapshot) {
    if (!nativeEnabled) return Promise.resolve(false);
    const task = mirrorChain.then(async () => {
      try {
        const response = await browser.runtime.sendNativeMessage("com.craigzone.diagnostics", snapshot);
        const ok = response?.ok === true;
        mirrorStatus = ok ? "available" : "unavailable";
        if (ok) lastMirrorAt = new Date().toISOString();
        return ok;
      }
      catch (_) { mirrorStatus = "unavailable"; return false; }
    });
    mirrorChain = task.then(() => {}, () => {});
    return task;
  }
  function queueStorage(work) {
    const task = storageChain.then(work);
    storageChain = task.then(() => {}, () => {});
    return task;
  }
  function scheduleWrite() {
    if (writeTimer) return;
    const delay = lastWrite ? Math.max(250, 10000 - (Date.now() - lastWrite)) : 250;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const snapshot = pending;
      pending = null;
      if (!snapshot) return;
      void queueStorage(async () => {
        try {
          await browser.storage.local.set({ [KEY]: snapshot });
          storageAvailable = true;
          lastWrite = Date.now();
          void queueMirror(snapshot);
        } catch (_) { storageAvailable = false; }
      }).catch(() => {});
    }, delay);
    writeTimer.unref?.();
  }
  function schedulePrune() {
    if (pruneTimer) clearTimeout(pruneTimer);
    const now = new Date();
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      void queueStorage(async () => {
        if (!state) state = await readStored();
        const pruned = clean(state, day());
        if (JSON.stringify(pruned) !== JSON.stringify(state)) {
          state = pruned;
          pending = state;
          scheduleWrite();
        }
        schedulePrune();
      }).catch(() => schedulePrune());
    }, Math.max(1000, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 1000));
    pruneTimer.unref?.();
  }

  globalThis.CraigZoneDiagnostics = {
    record: (name) => { void increment("actions", name); },
    failure: (name) => { void increment("failures", name); },
    size: (size) => { if (Number.isInteger(size) && size >= 1 && size <= 9) void increment("sessionSizes", String(size)); },
    permission: (outcome) => { if (["granted", "denied", "failed"].includes(outcome)) void increment("permissions", outcome); },
    get: async () => {
      await storageChain;
      return { ...clean(state || await readStored(), day()), status: { build: BUILD, browser: BROWSER, mirror: mirrorStatus, lastMirrorAt, storageAvailable } };
    },
    clear: async () => {
      let storageCleared = false;
      let mirrorCleared = false;
      try {
        await queueStorage(async () => {
          if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
          pending = null;
          try { await browser.storage.local.remove(KEY); storageCleared = true; }
          catch (_) { storageCleared = false; }
          state = blank();
          mirrorCleared = !nativeEnabled || await queueMirror(blank());
        });
      } catch (_) { state = blank(); }
      return { ok: storageCleared && mirrorCleared, storageCleared, mirrorCleared };
    },
    _clean: clean
  };

  // Initialize and prune before any public operation reaches the storage queue.
  void queueStorage(async () => {
    state = await readStored();
    try { await browser.storage.local.set({ [KEY]: state }); } catch (_) { storageAvailable = false; }
    void queueMirror(state);
    schedulePrune();
  }).catch(() => schedulePrune());

  function increment(field, name) {
    const allowed = field === "actions" ? ACTIONS : field === "failures" ? FAILURES : field === "sessionSizes" ? ["1","2","3","4","5","6","7","8","9"] : ["granted", "denied", "failed"];
    if (!allowed.includes(name)) return Promise.resolve();
    return queueStorage(async () => {
      if (!state) state = await readStored();
      const today = day();
      const row = state.days[today] ||= { actions: {}, failures: {}, builds: [], browsers: [], sessionSizes: {}, permissions: {} };
      row[field] ||= {};
      row[field][name] = Math.min(1000000, (row[field][name] || 0) + 1);
      row.builds = [...new Set([...(row.builds || []), ...(BUILD ? [BUILD] : [])])].slice(0, 4);
      row.browsers = [...new Set([...(row.browsers || []), BROWSER])];
      const minute = new Date(); minute.setUTCSeconds(0, 0);
      state.updatedAt = minute.toISOString();
      state = clean(state, today);
      pending = state;
      scheduleWrite();
    }).catch(() => {});
  }
})();
