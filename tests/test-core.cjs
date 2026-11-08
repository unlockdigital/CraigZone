const assert = require("node:assert/strict");
const path = require("node:path");

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), listeners };
}

const logs = [];
const fakeTabs = new Map([
  [1, { id: 1, windowId: 4, url: "https://one.example/game", title: "One", active: true, mutedInfo: { muted: true } }],
  [2, { id: 2, windowId: 4, url: "https://two.example/game", title: "Two", active: false, mutedInfo: { muted: false } }],
  [3, { id: 3, windowId: 4, url: "https://three.example/game", title: "Three", active: false, mutedInfo: { muted: true } }],
  [4, { id: 4, windowId: 4, url: "https://unrelated.example/", title: "Other", active: false, mutedInfo: { muted: false } }]
]);
const runtimeMessage = event();
const activated = event();
const removed = event();
const command = event();
const updated = event();
const permissionAdded = event();
const frameCompleted = event();
const stored = {};
let failInject = false;
let partialFrames = false;
let failPrepareFrame = null;
let failStageFrame = null;
let failFullscreenUpdate = false;
let denyPermissions = false;
let windowState = "normal";

global.browser = {
  runtime: { onMessage: runtimeMessage, sendMessage: async () => {}, getURL: (path = "") => "moz-extension://pilot/" + path },
  commands: { onCommand: command },
  action: { openPopup: async () => logs.push(["open-popup"]) },
  tabs: {
    onCreated: event(),
    onActivated: activated,
    onUpdated: updated,
    onRemoved: removed,
    query: async (query) => [...fakeTabs.values()].filter((tab) =>
      (query.windowId == null || tab.windowId === query.windowId) &&
      (!query.active || tab.active)),
    get: async (id) => fakeTabs.get(id),
    update: async (id, change) => {
      const tab = fakeTabs.get(id);
      if (!tab) throw new Error("missing tab");
      if (change.muted !== undefined) {
        logs.push(["mute", id, change.muted]);
        tab.mutedInfo.muted = change.muted;
      }
      if (change.active) {
        for (const current of fakeTabs.values()) if (current.windowId === tab.windowId) current.active = false;
        tab.active = true;
        logs.push(["activate", id]);
        for (const listener of activated.listeners) listener({ tabId: id, windowId: tab.windowId });
      }
      return tab;
    },
    sendMessage: async (id, message, options = {}) => {
      logs.push(["message", id, message.type, options.frameId, message.token, message.automatic]);
      if (message.type === "CZ_FS_PREPARE") return options.frameId === failPrepareFrame ? { ready: false, reason: "mock frame" } : { ready: true };
      if (message.type === "CZ_FS_STAGE") return options.frameId === failStageFrame ? { ok: false, reason: "mock stage" } : { ok: true };
      if (message.type === "CZ_FS_EXIT" || message.type === "CZ_FS_NATIVE_EXIT" || message.type === "CZ_FS_APPLY" || message.type === "CZ_FS_RESTORE") return { ok: true };
      return undefined;
    },
    onRemoved: removed,
    onActivated: activated
  },
  windows: {
    get: async () => ({ state: windowState }),
    update: async (id, change) => {
      logs.push(["window", id, change.state]);
      if (failFullscreenUpdate && change.state === "fullscreen") throw new Error("mock fullscreen update");
      windowState = change.state;
    }
  },
  storage: { session: {
    get: async (key) => ({ [key]: stored[key] }),
    set: async (obj) => { logs.push(["storage-set", Object.keys(obj)]); Object.assign(stored, obj); },
    remove: async (key) => { delete stored[key]; }
  } },
  permissions: { request: async () => true, contains: async () => !denyPermissions, onAdded: permissionAdded },
  webNavigation: {
    onCompleted: frameCompleted,
    getAllFrames: async ({ tabId }) => [
      { frameId: 0, parentFrameId: -1, url: fakeTabs.get(tabId).url },
      { frameId: 7, parentFrameId: 0, url: "https://player.example/embed" }
    ]
  },
  scripting: {
    executeScript: async ({ target, files }) => {
      logs.push(["inject", target.tabId, target.allFrames, files[0]]);
      if (failInject) throw new Error("mock injection failure");
      return partialFrames ? [{ frameId: 0 }, { frameId: 1, error: "missing host access" }] : [{ frameId: 0 }];
    },
    insertCSS: async ({ target, files }) => logs.push(["css", target.tabId, target.allFrames, files[0]])
    ,removeCSS: async ({ target, files }) => logs.push(["remove-css", target.tabId, target.allFrames, files[0]])
  }
};

const corePath = path.resolve(__dirname, "../src/background.js");
delete require.cache[corePath];
const core = require(corePath);
const messageHandler = runtimeMessage.listeners[0];
const commandHandler = command.listeners[0];
const removedHandler = removed.listeners[0];
const activatedHandler = activated.listeners[0];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function send(message, sender = {}) {
  const result = messageHandler(message, sender);
  return result && typeof result.then === "function" ? result : result;
}

(async () => {
  const popupSender = { url: "moz-extension://pilot/popup.html" };
  assert.equal(await send({ type: "CZ_START", ids: [1], windowId: 4 }, { tab: { id: 1 }, ...popupSender }), undefined,
    "content tab cannot invoke privileged start");
  const started = await send({ type: "CZ_START", ids: [1, 2], windowId: 4, playerOriginsByTab: { 1: ["https://player.example"], 2: [] } }, popupSender);
  assert.equal(started.ok, true, "popup starts selected session");
  assert.equal(started.total, 2);
  assert.equal(fakeTabs.get(1).mutedInfo.muted, false);
  assert.equal(fakeTabs.get(2).mutedInfo.muted, true);
  assert.equal(fakeTabs.get(4).mutedInfo.muted, true, "every other window tab is muted");
  assert.deepEqual(logs.filter((entry) => entry[0] === "inject").map((entry) => entry.slice(1)), [
    [1, true, "content.js"], [2, true, "content.js"]
  ]);
  assert(logs.findIndex((entry) => entry[0] === "mute" && entry[1] === 4 && entry[2] === true) <
    logs.findIndex((entry) => entry[0] === "mute" && entry[1] === 1 && entry[2] === false), "other tabs mute before target unmute");
  assert(stored.craigZoneSession?.originalMute, "session state is available for worker recovery");
  core._setSession(null);
  core._resetReadyForTest();
  await core._ensureReady();
  const popupSession = await send({ type: "CZ_GET_SESSION" }, popupSender);
  assert.equal(popupSession.enabled, true, "saved session rehydrates after a background worker restart");

  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "iframe" }, { tab: { id: 1 }, frameId: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "normal", "a fullscreen iframe cannot be committed without a reachable child player candidate");
  assert.match(stored.craigZoneSession.warning, /reachable player inside the fullscreen iframe/);

  failPrepareFrame = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "normal", "failed frame preflight keeps native fullscreen");
  assert.match(stored.craigZoneSession.warning, /cannot reach every player frame/);
  failPrepareFrame = null;
  failStageFrame = 0;
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "iframe" }, { tab: { id: 1 }, frameId: 0 });
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "normal", "stage failure keeps native fullscreen active");
  assert.match(stored.craigZoneSession.warning, /could not stage the complete player chain/);
  assert(logs.some((entry) => entry[0] === "message" && entry[2] === "CZ_FS_ABORT" && entry[3] === 7),
    "a stage failure rolls back already-staged descendant frames");
  assert(!logs.some((entry) => entry[0] === "message" && entry[2] === "CZ_FS_EXIT"),
    "native exit waits until every frame stages successfully");
  failStageFrame = null;
  failFullscreenUpdate = true;
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  failFullscreenUpdate = false;
  assert.equal(windowState, "normal", "window transition failure does not leave a partial fullscreen session");
  assert.deepEqual(stored.craigZoneSession.fullscreenByTab, {}, "failed window transition clears the staged operation");
  assert.equal(logs.filter((entry) => entry[0] === "message" && entry[2] === "CZ_FS_ABORT").length, 2,
    "window transition failure rolls back every staged frame");
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "iframe" }, { tab: { id: 1 }, frameId: 0 });
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "fullscreen", "fullscreen begins only after every frame is prepared and expanded");
  const fullscreenMessages = logs.filter((entry) => entry[0] === "message" && /^CZ_FS_(EXIT|APPLY)$/.test(entry[2]));
  assert.deepEqual(fullscreenMessages.map((entry) => entry[2]), ["CZ_FS_EXIT", "CZ_FS_APPLY", "CZ_FS_APPLY"]);
  const phases = logs.filter((entry) => entry[0] === "message" && /^CZ_FS_(STAGE|EXIT|APPLY)$/.test(entry[2])).map((entry) => entry[2]);
  assert.deepEqual(phases, ["CZ_FS_STAGE", "CZ_FS_STAGE", "CZ_FS_EXIT", "CZ_FS_APPLY", "CZ_FS_APPLY"],
    "both player frames stage before native exit, then finalize child-to-top");
  assert(logs.findIndex((entry) => entry[0] === "window" && entry[2] === "fullscreen") <
    logs.findIndex((entry) => entry[0] === "storage-set"),
  "Firefox enters fullscreen before the post-bridge session persistence write");
  assert.equal(fullscreenMessages.filter((entry) => entry[2] === "CZ_FS_EXIT").length, 1,
    "simultaneous iframe and player candidates produce exactly one top-frame exit");
  assert(fullscreenMessages.find((entry) => entry[2] === "CZ_FS_EXIT")?.[4],
    "top-frame exit carries the prepared fullscreen token");
  const operation = stored.craigZoneSession.fullscreenByTab["1"];
  const restoredFullscreen = await send({ type: "CZ_FS_RESTORE_REQUEST", token: operation.tokens[0] }, { tab: { id: 1 }, frameId: 7 });
  assert.equal(restoredFullscreen.ok, true);
  assert.equal(windowState, "normal", "Escape restore request returns the window to its original state");

  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "fullscreen");
  windowState = "normal";
  await send({ type: "CZ_FS_CHECK_WINDOW" }, { tab: { id: 1 }, frameId: 7 });
  await flush();
  assert.deepEqual(stored.craigZoneSession.fullscreenByTab, {}, "content resize checks restore styles after Firefox exits fullscreen");

  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  windowState = "normal";
  for (const tab of fakeTabs.values()) tab.active = tab.id === 2;
  activatedHandler({ tabId: 2, windowId: 4 });
  await flush();
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 2 }, frameId: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(Object.keys(stored.craigZoneSession.fullscreenByTab).sort(), ["1", "2"], "fullscreen operations persist independently for both selected tabs");
  windowState = "normal";
  await send({ type: "CZ_FS_CHECK_WINDOW" }, { tab: { id: 2 }, frameId: 0 });
  assert.deepEqual(stored.craigZoneSession.fullscreenByTab, {}, "an active tab with no local theater still restores another slot's fullscreen operation");
  for (const tab of fakeTabs.values()) tab.active = tab.id === 1;
  activatedHandler({ tabId: 1, windowId: 4 });
  await flush();

  assert.equal(core._stateFor(1).active, true, "state marks the currently selected session tab active");
  assert.equal(core._stateFor(1).autoFullscreenAllowed, true, "automatic theater is available by default");
  assert.equal(core._stateFor(2).active, false, "inactive slots are marked inactive for content controllers");
  assert.equal(core._stateFor(2).autoFullscreenAllowed, false, "automatic theater remains restricted to the active slot");
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video", automatic: true }, { tab: { id: 2 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logs.some((entry) => entry[0] === "message" && entry[2] === "CZ_FS_PREPARE"), false, "inactive tabs cannot start automatic theater");
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video", automatic: true }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "fullscreen", "an exact playing-video candidate can enter automatic theater");
  const autoPhases = logs.filter((entry) => entry[0] === "message" && /^CZ_FS_(PREPARE|STAGE|EXIT|APPLY)$/.test(entry[2]));
  assert.deepEqual(autoPhases.map((entry) => entry[2]), ["CZ_FS_PREPARE", "CZ_FS_PREPARE", "CZ_FS_STAGE", "CZ_FS_STAGE", "CZ_FS_APPLY", "CZ_FS_APPLY"],
    "automatic theater stages and applies the verified frame chain without exiting native fullscreen");
  assert(autoPhases.every((entry) => entry[5] === true), "automatic transaction mode is carried through each protocol phase");
  assert(!autoPhases.some((entry) => entry[2] === "CZ_FS_EXIT"), "automatic mode never issues a page fullscreen exit");
  assert(logs.findIndex((entry) => entry[0] === "window" && entry[2] === "fullscreen") < logs.findIndex((entry) => entry[0] === "storage-set"),
    "automatic window expansion precedes the post-bridge persistence write");
  const autoOperation = stored.craigZoneSession.fullscreenByTab["1"];
  const optOut = await send({ type: "CZ_FS_RESTORE_REQUEST", token: autoOperation.tokens[0], optOut: true }, { tab: { id: 1 }, frameId: 7 });
  assert.equal(optOut.ok, true);
  assert.equal(core._stateFor(1).autoFullscreenAllowed, false, "Escape can disable automatic theater for this tab");
  core._setSession(null);
  core._resetReadyForTest();
  await core._ensureReady();
  assert.equal(core._stateFor(1).autoFullscreenAllowed, false, "the opt-out survives background worker recovery");
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video", automatic: true }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "normal", "automatic theater stays off until a manual fullscreen confirmation");
  assert.equal(logs.some((entry) => entry[0] === "message" && entry[2] === "CZ_FS_PREPARE"), false, "opted-out auto candidates do not enter frame preparation");
  failFullscreenUpdate = true;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(core._stateFor(1).autoFullscreenAllowed, false, "a failed manual confirmation keeps the opt-out");
  failFullscreenUpdate = false;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(windowState, "fullscreen", "a manual fullscreen confirmation remains available after opt-out");
  assert.equal(core._stateFor(1).autoFullscreenAllowed, true, "successful manual theater confirmation reenables automatic mode");
  const manualOperation = stored.craigZoneSession.fullscreenByTab["1"];
  await send({ type: "CZ_FS_RESTORE_REQUEST", token: manualOperation.tokens[0] }, { tab: { id: 1 }, frameId: 7 });
  assert.equal(core._stateFor(1).autoFullscreenAllowed, true, "ordinary Escape restoration preserves the current opt-in");
  logs.length = 0;
  await send({ type: "CZ_FS_CANDIDATE", kind: "video" }, { tab: { id: 1 }, frameId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const repeatedOperation = stored.craigZoneSession.fullscreenByTab["1"];
  await send({ type: "CZ_FS_RESTORE_REQUEST", token: repeatedOperation.tokens[0], optOut: true, nativeExit: true }, { tab: { id: 1 }, frameId: 7 });
  const nativeExits = logs.filter((entry) => entry[0] === "message" && entry[2] === "CZ_FS_NATIVE_EXIT");
  assert.deepEqual(nativeExits.map((entry) => entry[3]), [0], "repeat native fullscreen exits once from the top frame before restoring the chain");
  assert.equal(core._stateFor(1).autoFullscreenAllowed, false, "repeat native fullscreen opts this tab out of automatic theater");

  const beforeUnknown = logs.filter((entry) => entry[0] === "activate").length;
  await send({ type: "CZ_KEY", action: "next" }, { tab: { id: 4 } });
  assert.equal(logs.filter((entry) => entry[0] === "activate").length, beforeUnknown, "unknown tab sender is ignored");
  const muted = await send({ type: "CZ_KEY", action: "mute" }, { tab: { id: 1 } });
  assert.deepEqual(muted, { ok: true, muted: true }, "M toggles the active game's mute state");
  assert.equal(core._stateFor(1).muted, true, "muted state is included in the content overlay state");
  await send({ type: "CZ_KEY", action: "next" }, { tab: { id: 1 } });
  await send({ type: "CZ_KEY", action: "next" }, { tab: { id: 2 } });
  await flush();
  assert.equal(fakeTabs.get(1).active, true, "rapid next commands serialize and wrap");
  assert.equal(fakeTabs.get(1).mutedInfo.muted, true, "per-game mute choice survives switching away and back");
  assert.equal(fakeTabs.get(2).mutedInfo.muted, true);
  const unmuted = await send({ type: "CZ_KEY", action: "mute" }, { tab: { id: 1 } });
  assert.deepEqual(unmuted, { ok: true, muted: false }, "M toggles the active game back on");
  assert.equal(fakeTabs.get(1).mutedInfo.muted, false);

  for (const tab of fakeTabs.values()) tab.active = tab.id === 2;
  activatedHandler({ tabId: 2, windowId: 4 });
  await flush();
  assert.equal(fakeTabs.get(2).active, true, "manual activation is recognized");
  assert.equal(fakeTabs.get(2).mutedInfo.muted, false, "manually selected enrolled tab is unmuted after others mute");
  assert.equal(fakeTabs.get(1).mutedInfo.muted, true);
  activatedHandler({ tabId: 1, windowId: 4 });
  await flush();
  assert.equal(fakeTabs.get(2).active, true, "stale activation notifications cannot rewind the selected tab");

  await send({ type: "CZ_KEY", action: "mute" }, { tab: { id: 2 } });
  assert.equal(fakeTabs.get(2).mutedInfo.muted, true, "M can mute the active game before stop");
  const restore = await send({ type: "CZ_STOP_SESSION" }, popupSender);
  assert.equal(restore.enabled, false);
  assert.equal(fakeTabs.get(1).mutedInfo.muted, true, "original muted state restored");
  assert.equal(fakeTabs.get(2).mutedInfo.muted, false, "original unmuted state restored");
  assert.equal(fakeTabs.get(3).mutedInfo.muted, true, "original muted state restored");
  assert.equal(fakeTabs.get(4).mutedInfo.muted, false, "unrelated tab state restored");
  assert.equal(windowState, "normal", "original window state restored after fullscreen");
  assert(logs.some((entry) => entry[0] === "remove-css" && entry[1] === 1), "stop removes injected CSS");

  failInject = true;
  const failedStart = await send({ type: "CZ_START", ids: [1], windowId: 4, playerOriginsByTab: { 1: [] } }, popupSender);
  assert.equal(failedStart.ok, false, "injection failure is returned to the popup");
  assert.match(failedStart.error, /mock injection failure/);
  assert.equal(fakeTabs.get(1).mutedInfo.muted, true, "failed start restores original mute state");
  failInject = false;

  partialFrames = true;
  const partialStart = await send({ type: "CZ_START", ids: [1], windowId: 4, playerOriginsByTab: { 1: [] } }, popupSender);
  assert.match(partialStart.error, /stayed stopped because player controls would be incomplete/);
  assert.equal((await send({ type: "CZ_GET_SESSION" }, popupSender)).enabled, false, "partial frame injection never starts a misleading session");
  partialFrames = false;

  logs.length = 0;
  await send({ type: "CZ_START", ids: [1, 2], windowId: 4, playerOriginsByTab: { 1: ["https://player.example"], 2: [] } }, popupSender);
  fakeTabs.delete(1);
  removedHandler(1, { windowId: 4 });
  await flush();
  const liveSession = await send({ type: "CZ_GET_SESSION" }, popupSender);
  assert.deepEqual(liveSession.tabs.map((tab) => tab.id), [2], "closing a selected tab removes its slot");
  assert.equal(fakeTabs.get(2).active, true, "remaining tab stays selected after close");
  await send({ type: "CZ_STOP_SESSION" }, popupSender);

  fakeTabs.set(1, { id: 1, windowId: 4, url: "https://one.example/game", title: "One", active: false, mutedInfo: { muted: true } });
  await send({ type: "CZ_START", ids: [1, 2], windowId: 4 }, popupSender);
  const beforeEdit = await send({ type: "CZ_GET_SESSION" }, popupSender);
  const gameBeforeControls = fakeTabs.get(beforeEdit.activeId);
  const mutedBeforeControls = gameBeforeControls.mutedInfo.muted;
  fakeTabs.set(5, { id:5,windowId:4,url:"moz-extension://pilot/popup.html",active:true,mutedInfo:{muted:false} });
  for (const tab of fakeTabs.values()) tab.active = tab.id === 5;
  activatedHandler({tabId:5,windowId:4}); await flush();
  assert.equal((await send({type:"CZ_GET_SESSION"},popupSender)).activeId,beforeEdit.activeId,"the controls page keeps the current game identity");
  assert.equal(gameBeforeControls.mutedInfo.muted,mutedBeforeControls,"the controls page preserves the current game's audio");
  logs.length = 0;
  const edited = await send({ type: "CZ_UPDATE_SESSION", ids: [1, 2, 3], windowId: 4 }, popupSender);
  assert.equal(edited.ok, true, "a game joins the running session");
  let lineup = await send({ type: "CZ_GET_SESSION" }, popupSender);
  assert.deepEqual(lineup.tabs.map(({ id, slot }) => [id, slot]), [[1,1],[2,2],[3,3]], "joining preserves surviving game slots");
  assert.equal(lineup.activeId, beforeEdit.activeId, "joining preserves the active game");
  assert.equal(logs.some((entry) => entry[0] === "message" && entry[2] === "CZ_STOP" && [1,2].includes(entry[1])), false, "joining leaves existing content controllers running");
  assert.equal(fakeTabs.get(3).mutedInfo.muted, true, "new background game is silent");
  assert.equal((await send({ type: "CZ_UPDATE_SESSION", ids: [2,3], windowId: 4 }, popupSender)).ok, true);
  lineup = await send({ type: "CZ_GET_SESSION" }, popupSender);
  assert.deepEqual(lineup.tabs.map(({ id, slot }) => [id,slot]), [[2,2],[3,3]], "removal leaves stable slot numbers");
  const snapshot = JSON.stringify(lineup);
  denyPermissions = true;
  assert.equal((await send({ type: "CZ_UPDATE_SESSION", ids: [1,2,3], windowId: 4 }, popupSender)).ok, false, "denied access refuses the edit");
  denyPermissions = false;
  assert.equal(JSON.stringify(await send({ type: "CZ_GET_SESSION" }, popupSender)), snapshot, "permission refusal preserves the complete running lineup");
  failInject = true;
  assert.equal((await send({ type: "CZ_UPDATE_SESSION", ids: [1,2,3], windowId: 4 }, popupSender)).ok, false, "failed new-player preparation refuses the edit");
  failInject = false;
  assert.equal(JSON.stringify(await send({ type: "CZ_GET_SESSION" }, popupSender)), snapshot, "failed new-player preparation preserves the running lineup");
  assert.equal((await send({ type: "CZ_UPDATE_SESSION", ids: [2,2], windowId: 4 }, popupSender)).ok, false, "duplicate game IDs are rejected");
  assert.equal(await send({ type: "CZ_UPDATE_SESSION", ids: [2], windowId: 4 }, { tab: {id: 4}, url: "https://unrelated.example" }), undefined, "web content cannot edit the session");
  await send({ type: "CZ_WATCH_GAME", tabId: 3 }, popupSender);
  assert.equal(fakeTabs.get(3).active, true, "Watch returns to the selected game");
  assert.equal(fakeTabs.get(2).mutedInfo.muted, true, "Watch keeps other games muted");
  await send({ type: "CZ_STOP_SESSION" }, popupSender);
  core._setSession(null);
  console.log("Craig Zone core mocked checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
