const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../src/diagnostics.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function load(browser) {
  global.browser = browser;
  delete require.cache[modulePath];
  require(modulePath);
  return global.CraigZoneDiagnostics;
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const startupRead = deferred();
  const startupData = { craigZoneDiagnosticsV1: { version: 1, days: { [today]: { actions: { starts: 4 } } } } };
  const startupValues = {};
  const startup = load({
    storage: { local: {
      get: () => startupRead.promise,
      set: async (data) => Object.assign(startupValues, data),
      remove: async (key) => { delete startupValues[key]; }
    } },
    runtime: { sendNativeMessage: async () => ({ ok: true }) }
  });
  startup.record("starts");
  startupRead.resolve(startupData);
  const afterStartup = await startup.get();
  assert.equal(afterStartup.days[today].actions.starts, 5, "early records wait for startup pruning and keep the loaded count");
  await pause(300);
  assert.equal(startupValues.craigZoneDiagnosticsV1.days[today].actions.starts, 5, "startup pruning cannot overwrite an early record");

  const delayedInit = deferred();
  const sameTickValues = {};
  const sameTick = load({
    storage: { local: {
      get: () => delayedInit.promise,
      set: async (data) => Object.assign(sameTickValues, data),
      remove: async (key) => { delete sameTickValues[key]; }
    } },
    runtime: { sendNativeMessage: async () => ({ ok: true }) }
  });
  sameTick.record("starts");
  const sameTickClear = sameTick.clear();
  delayedInit.resolve({});
  const sameTickResult = await sameTickClear;
  assert.equal(sameTickResult.storageCleared, true);
  await pause(350);
  assert.equal(sameTickValues.craigZoneDiagnosticsV1, undefined, "same-tick record and clear cannot leave a delayed write behind");

  const firstWrite = deferred();
  let deferNextSet = false;
  const values = {};
  const mirrorCalls = [];
  const diagnostics = load({
    storage: { local: {
      get: async (key) => ({ [key]: values[key] }),
      set: async (data) => {
        if (deferNextSet) { deferNextSet = false; await firstWrite.promise; }
        Object.assign(values, data);
      },
      remove: async (key) => { delete values[key]; }
    } },
    runtime: { sendNativeMessage: async (host, message) => { mirrorCalls.push([host, message]); return { ok: true }; } }
  });
  await diagnostics.get();
  diagnostics.record("switches");
  await diagnostics.get();
  deferNextSet = true;
  await pause(300);
  let clearFinished = false;
  const clearing = diagnostics.clear().then((result) => { clearFinished = true; return result; });
  await pause(20);
  assert.equal(clearFinished, false, "clear waits for an in-flight storage write before removing the key");
  firstWrite.resolve();
  const clearResult = await clearing;
  assert.deepEqual(clearResult, { ok: true, storageCleared: true, mirrorCleared: true });
  assert.equal(values.craigZoneDiagnosticsV1, undefined, "an in-flight write cannot resurrect data after clear completes");
  assert.deepEqual(mirrorCalls.at(-1)[1], { version: 2, days: {}, updatedAt: null }, "clear's empty mirror is delivered last");

  const nativePending = [];
  const nativeCalls = [];
  const nativeValues = {};
  const ordered = load({
    storage: { local: {
      get: async (key) => ({ [key]: nativeValues[key] }),
      set: async (data) => Object.assign(nativeValues, data),
      remove: async (key) => { delete nativeValues[key]; }
    } },
    runtime: { sendNativeMessage: (host, message) => {
      const wait = deferred();
      nativeCalls.push(message);
      nativePending.push(wait);
      return wait.promise;
    } }
  });
  await ordered.get();
  assert.equal(nativePending.length, 1, "startup mirror begins first");
  ordered.record("mutes");
  await ordered.get();
  await pause(300);
  const orderedClear = ordered.clear();
  await pause(20);
  assert.equal(nativePending.length, 1, "later mirror waits behind the unresolved startup mirror");
  nativePending[0].resolve({ ok: true });
  await pause(20);
  assert.equal(nativePending.length, 2, "the coalesced snapshot follows startup on the mirror queue");
  nativePending[1].resolve({ ok: true });
  await pause(20);
  assert.equal(nativePending.length, 3, "the clear snapshot follows earlier native messages");
  nativePending[2].resolve({ ok: true });
  const result = await orderedClear;
  assert.equal(result.mirrorCleared, true);
  assert.deepEqual(nativeCalls.at(-1), { version: 2, days: {}, updatedAt: null }, "native delivery order leaves clear as the final host state");

  const failedClear = load({
    storage: { local: {
      get: async () => ({}), set: async () => {},
      remove: async () => { throw new Error("private diagnostic detail"); }
    } },
    runtime: { sendNativeMessage: async () => { throw new Error("private host detail"); } }
  });
  const failed = await failedClear.clear();
  assert.deepEqual(failed, { ok: false, storageCleared: false, mirrorCleared: false }, "clear exposes only boolean outcomes");
  assert.equal(JSON.stringify(failed).includes("private"), false, "clear status contains no error details");

  const rejectedMirror = load({
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { sendNativeMessage: async () => ({ ok: false }) }
  });
  assert.deepEqual(await rejectedMirror.clear(), { ok: false, storageCleared: true, mirrorCleared: false },
    "a resolved native message carrying a rejected schema response does not confirm mirror clear");

  console.log("Craig Zone diagnostics race and clear-status checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
