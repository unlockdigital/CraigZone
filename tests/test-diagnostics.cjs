const assert = require("node:assert/strict");
const path = require("node:path");

const values = {};
let failWrites = false;
const nativeMessages = [];
global.browser = {
  storage: { local: {
    get: async (key) => ({ [key]: values[key] }),
    set: async (entry) => { if (failWrites) throw new Error("storage unavailable"); Object.assign(values, entry); },
    remove: async (key) => { delete values[key]; }
  } },
  runtime: { sendNativeMessage: async (host, message) => { nativeMessages.push([host, message]); return { ok: true }; } }
};

const modulePath = path.resolve(__dirname, "../src/diagnostics.js");
delete require.cache[modulePath];
require(modulePath);
const diagnostics = global.CraigZoneDiagnostics;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  const cleaned = diagnostics._clean({
    version: 1,
    title: "sensitive title",
    url: "https://private.example/path",
    days: {
      [old]: { actions: { switches: 12 } },
      [today]: { actions: { switches: 3, mutes: 1 }, failures: { fullscreen: 2 }, tabId: 123 }
    }
  }, today);
  assert.deepEqual(Object.keys(cleaned), ["version", "days", "updatedAt"], "schema excludes arbitrary metadata");
  assert.deepEqual(Object.keys(cleaned.days), [today], "retention removes days older than seven UTC dates");
  assert.deepEqual(cleaned.days[today].actions, { switches: 3, mutes: 1, starts: 0, stops: 0, fullscreen: 0, edits: 0 });
  assert.deepEqual(cleaned.days[today].failures, { start: 0, switch: 0, mute: 0, stop: 0, fullscreen: 2, edit: 0 });
  assert.deepEqual(diagnostics._clean({ version: 99, days: {} }, today), { version: 2, days: {}, updatedAt: null }, "malformed schema resets safely");

  diagnostics.record("switches");
  diagnostics.record("switches");
  diagnostics.record("mutes");
  diagnostics.record("https://must-not-be-stored.example");
  diagnostics.failure("fullscreen");
  await pause(350);
  const stored = values.craigZoneDiagnosticsV1;
  assert.equal(stored.days[today].actions.switches, 2, "coalesced writes keep each completed event");
  assert.equal(stored.days[today].actions.mutes, 1);
  assert.equal(stored.days[today].failures.fullscreen, 1);
  assert.equal(JSON.stringify(stored).includes("must-not-be-stored"), false, "unknown labels and raw data are discarded");
  assert.deepEqual(Object.keys(stored), ["version", "days", "updatedAt"], "storage contains the allowlisted top-level schema");
  assert(nativeMessages.some(([host, message]) => host === "com.craigzone.diagnostics" && message.version === 2), "optional mirror receives only the bounded aggregate schema");

  await diagnostics.clear();
  assert.equal(values.craigZoneDiagnosticsV1, undefined, "clear removes local aggregate storage");
  assert.deepEqual(nativeMessages.at(-1)[1], { version: 2, days: {}, updatedAt: null }, "clear mirrors an empty snapshot");

  failWrites = true;
  diagnostics.record("starts");
  await pause(350);
  assert.equal(failWrites, true, "storage write failure is contained");
  assert.equal(diagnostics._clean(null, today).version, 2, "diagnostics remain readable after storage failure");
  console.log("CraigZone diagnostics mocked privacy and resilience checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
