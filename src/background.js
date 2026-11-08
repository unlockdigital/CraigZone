/* global browser */
(() => {
  const MAX_SLOTS = 9;
  let session = null;
  let mutationQueue = Promise.resolve();
  let readyPromise = null;
  const candidateBatches = new Map();
  const diagnostics = globalThis.CraigZoneDiagnostics || { record: () => {}, failure: () => {}, get: async () => ({ version: 1, days: {} }), clear: async () => {} };

  function sessionRecord() {
    if (!session) return null;
    return {
      windowId: session.windowId,
      tabs: session.tabs,
      activeId: session.activeId,
      previousId: session.previousId,
      lastGameId: session.lastGameId,
      originalMute: [...session.originalMute.entries()],
      gameMuteChoices: session.gameMuteChoices || {},
      mutedByTab: session.mutedByTab || {},
      originalWindowState: session.originalWindowState,
      warning: session.warning || "",
      fullscreenByTab: session.fullscreenByTab || {},
      autoOptOutByTab: session.autoOptOutByTab || {},
      stopping: Boolean(session.stopping)
    };
  }

  async function persistSession() {
    try {
      if (session) await browser.storage.session.set({ craigZoneSession: sessionRecord() });
      else await browser.storage.session.remove("craigZoneSession");
    } catch (_) { /* In-memory session still works if session storage is unavailable. */ }
  }

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = browser.storage.session.get("craigZoneSession").then(async ({ craigZoneSession }) => {
        if (craigZoneSession?.windowId != null && Array.isArray(craigZoneSession.tabs)) {
          session = { ...craigZoneSession, originalMute: new Map(craigZoneSession.originalMute || []) };
          session.gameMuteChoices ||= {};
          session.mutedByTab ||= {};
          session.autoOptOutByTab ||= {};
          if (!session.fullscreenByTab) {
            session.fullscreenByTab = {};
            if (session.fullscreen?.tabId != null) session.fullscreenByTab[session.fullscreen.tabId] = session.fullscreen;
            delete session.fullscreen;
          }
          if (session.stopping) await stopSession();
        }
      }).catch(() => {});
    }
    return readyPromise;
  }

  const enqueue = (work) => {
    const next = mutationQueue.then(work, work);
    mutationQueue = next.catch(() => {});
    return next;
  };

  const stateFor = (tabId) => {
    const member = session?.tabs.find((entry) => entry.id === tabId);
    return {
      enabled: Boolean(session && !session.stopping),
      slot: member ? member.slot : 0,
      total: session?.tabs.length || 0,
      label: member?.label || "",
      warning: session?.warning || "",
      muted: Boolean(session?.mutedByTab?.[tabId] ?? false),
      active: Boolean(session && !session.stopping && session.activeId === tabId),
      autoFullscreenAllowed: Boolean(session && !session.stopping && session.activeId === tabId && !session.autoOptOutByTab?.[tabId])
    };
  };

  async function broadcastState() {
    if (!session) return;
    const tabs = [...session.tabs];
    await Promise.allSettled(tabs.map(({ id }) => browser.tabs.sendMessage(id, {
      type: "CZ_STATE", ...stateFor(id)
    })));
    notifyControls();
  }

  function notifyControls() {
    try { void browser.runtime.sendMessage({ type: "CZ_SESSION_CHANGED" }).catch(() => {}); }
    catch (_) { /* A closing controls page needs no notification. */ }
  }

  async function captureAndMuteOthers(targetId) {
    const windowTabs = await browser.tabs.query({ windowId: session.windowId });
    session.gameMuteChoices ||= {};
    session.mutedByTab ||= {};
    const preferredMuted = Object.hasOwn(session.gameMuteChoices, targetId)
      ? Boolean(session.gameMuteChoices[targetId]) : false;
    for (const tab of windowTabs) {
      if (!session.originalMute.has(tab.id)) session.originalMute.set(tab.id, Boolean(tab.mutedInfo?.muted));
    }
    await persistSession();
    for (const tab of windowTabs) {
      if (tab.id !== targetId && !tab.mutedInfo?.muted) {
        await browser.tabs.update(tab.id, { muted: true });
      }
    }
    const target = windowTabs.find((tab) => tab.id === targetId);
    if (!target) throw new Error("The selected CraigZone tab is no longer open.");
    if (Boolean(target.mutedInfo?.muted) !== preferredMuted) await browser.tabs.update(targetId, { muted: preferredMuted });
    for (const tab of windowTabs) session.mutedByTab[tab.id] = tab.id === targetId ? preferredMuted : true;
    if (!target.active) await browser.tabs.update(targetId, { active: true });
    session.activeId = targetId;
    session.lastGameId = targetId;
    await persistSession();
  }

  async function selectIndex(index) {
    if (!session || !session.tabs.length) return false;
    const length = session.tabs.length;
    const normalized = (index + length) % length;
    const target = session.tabs[normalized];
    if (target.id === session.activeId) return false;
    await captureAndMuteOthers(target.id);
    await broadcastState();
    diagnostics.record("switches");
    return true;
  }

  async function move(action) {
    if (!session) return false;
    const currentActive = await browser.tabs.query({ active: true, windowId: session.windowId });
    if (!session.activeId || currentActive[0]?.id !== session.activeId) return false;
    const currentIndex = Math.max(0, session.tabs.findIndex((tab) => tab.id === session.activeId));
    if (action === "last") {
      if (session.previousId == null || session.previousId === session.activeId) return false;
      const index = session.tabs.findIndex((tab) => tab.id === session.previousId);
      if (index < 0) return false;
      const oldId = session.activeId;
      const didSwitch = await selectIndex(index);
      if (didSwitch) { session.previousId = oldId; await persistSession(); }
      return didSwitch;
    }
    const direction = action === "previous" ? -1 : 1;
    const next = (currentIndex + direction + session.tabs.length) % session.tabs.length;
    const oldId = session.activeId;
    const didSwitch = await selectIndex(next);
    if (didSwitch) { session.previousId = oldId; await persistSession(); }
    return didSwitch;
  }

  async function toggleActiveMute(tabId) {
    if (!session || !session.tabs.some((tab) => tab.id === tabId)) return { ok: false };
    const target = await browser.tabs.get(tabId);
    const muted = !Boolean(target.mutedInfo?.muted);
    await browser.tabs.update(tabId, { muted });
    session.gameMuteChoices ||= {};
    session.mutedByTab ||= {};
    session.gameMuteChoices[tabId] = muted;
    session.mutedByTab[tabId] = muted;
    await persistSession();
    await broadcastState();
    diagnostics.record("mutes");
    return { ok: true, muted };
  }

  async function stopSession(countDiagnostic = true) {
    const old = session;
    if (!old) return { ok: true, enabled: false };
    old.stopping = true;
    await persistSession();
    await Promise.allSettled(old.tabs.map(({ id }) => Promise.allSettled([
      browser.tabs.sendMessage(id, { type: "CZ_STOP" }),
      browser.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        func: () => globalThis.__craigZoneContentControllerV1?.cleanup?.()
      }),
      browser.scripting.removeCSS({ target: { tabId: id, allFrames: true }, files: ["content.css"] })
    ])));
    const existing = await browser.tabs.query({ windowId: old.windowId }).catch(() => []);
    for (const tab of existing) {
      if (old.originalMute.has(tab.id)) {
        const muted = old.originalMute.get(tab.id);
        if (Boolean(tab.mutedInfo?.muted) !== muted) {
          await browser.tabs.update(tab.id, { muted }).catch(() => {});
        }
      }
    }
    if (old.originalWindowState != null) {
      await browser.windows.update(old.windowId, { state: old.originalWindowState }).catch(() => {});
    }
    session = null;
    await persistSession();
    notifyControls();
    if (countDiagnostic) diagnostics.record("stops");
    return { ok: true, enabled: false };
  }

  function matchPattern(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  async function startSession(ids, windowId, playerOriginsByTab = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SLOTS ||
        ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) {
      throw new Error("Choose between 1 and 9 tabs.");
    }
    if (session) await stopSession();
    const all = await browser.tabs.query({ windowId });
    const byId = new Map(all.map((tab) => [tab.id, tab]));
    const chosen = ids.map((id) => byId.get(id));
    if (chosen.some((tab) => !tab || !/^https?:/.test(tab.url || ""))) {
      throw new Error("Every selected tab must be an open HTTP or HTTPS page in this window.");
    }
    const patterns = ids.flatMap((id, index) => [
      matchPattern(chosen[index].url),
      ...(Array.isArray(playerOriginsByTab[id]) ? playerOriginsByTab[id].map(matchPattern) : [])
    ]);
    const grants = await Promise.all([...new Set(patterns)].map(async (origin) => [origin, await browser.permissions.contains({ origins: [origin] })]));
    const missing = grants.filter(([, allowed]) => !allowed).map(([origin]) => origin);
    if (missing.length) throw new Error(`Player access is incomplete. Grant these selected origins before starting: ${missing.join(", ")}`);
    const active = all.find((tab) => tab.active && ids.includes(tab.id));
    const activeId = active?.id ?? ids[0];
    const window = await browser.windows.get(windowId);
    session = {
      windowId,
      tabs: chosen.map((tab, index) => ({
        id: tab.id, slot: index + 1, label: tab.title || tab.url || `Tab ${index + 1}`,
        origin: new URL(tab.url).origin,
        playerOrigins: [...new Set((playerOriginsByTab[tab.id] || []).filter((origin) => origin !== new URL(tab.url).origin))]
      })),
      activeId: null,
      previousId: null,
      originalMute: new Map(all.map((tab) => [tab.id, Boolean(tab.mutedInfo?.muted)])),
      originalWindowState: window.state,
      fullscreenByTab: {},
      autoOptOutByTab: {},
      gameMuteChoices: {},
      mutedByTab: {}
    };
    try {
      await captureAndMuteOthers(activeId);
      for (const tab of session.tabs) {
        const result = await browser.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
        const failures = Array.isArray(result) ? result.filter((frame) => frame.error) : [];
        if (failures.length) throw new Error(`CraigZone could not reach ${failures.length} frames in slot ${tab.slot}. It stayed stopped because player controls would be incomplete.`);
        await browser.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["content.css"] });
      }
      await broadcastState();
      diagnostics.record("starts");
      diagnostics.size?.(session.tabs.length);
      await browser.tabs.sendMessage(activeId, { type: "CZ_READY_PLAYER" }).catch(() => {});
      return { ok: true, ...stateFor(activeId) };
    } catch (error) {
      await stopSession(false);
      throw error;
    }
  }

  async function cleanMember(tabId) {
    await Promise.allSettled([
      browser.tabs.sendMessage(tabId, { type: "CZ_STOP" }),
      browser.scripting.executeScript({ target: { tabId, allFrames: true },
        func: () => globalThis.__craigZoneContentControllerV1?.cleanup?.() }),
      browser.scripting.removeCSS({ target: { tabId, allFrames: true }, files: ["content.css"] })
    ]);
  }

  async function updateSession(ids, windowId, playerOriginsByTab = {}) {
    if (!session || session.stopping || windowId !== session.windowId) throw new Error("Open controls in the running game window.");
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SLOTS ||
        ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) throw new Error("Choose 1–9 different game tabs.");
    const all = await browser.tabs.query({ windowId });
    const byId = new Map(all.map((tab) => [tab.id, tab]));
    const chosen = ids.map((id) => byId.get(id));
    if (chosen.some((tab) => !tab || !/^https?:/.test(tab.url || ""))) throw new Error("A selected game moved or closed. Check your choices again.");
    const patterns = chosen.flatMap((tab) => [matchPattern(tab.url),
      ...(Array.isArray(playerOriginsByTab[tab.id]) ? playerOriginsByTab[tab.id].map(matchPattern) : [])]);
    if ((await Promise.all([...new Set(patterns)].map((origin) => browser.permissions.contains({ origins: [origin] })))).some((ok) => !ok)) {
      throw new Error("Approve access to the newly selected player sites before applying games.");
    }
    const old = session;
    const existing = new Map(old.tabs.map((tab) => [tab.id, tab]));
    const additions = chosen.filter((tab) => !existing.has(tab.id));
    const staged = [];
    try {
      for (const tab of additions) {
        staged.push(tab.id);
        const result = await browser.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
        if (Array.isArray(result) && result.some((frame) => frame.error)) throw new Error("A new player frame is unavailable. Your current games stay running.");
        await browser.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["content.css"] });
      }
    } catch (error) {
      await Promise.allSettled(staged.map(cleanMember));
      throw error;
    }
    const kept = old.tabs.filter((tab) => ids.includes(tab.id));
    const used = new Set(kept.map((tab) => tab.slot));
    const nextTabs = [...kept, ...additions.map((tab) => {
      let slot = 1;
      while (used.has(slot)) slot += 1;
      used.add(slot);
      return { id: tab.id, slot };
    })].map((entry) => {
      const tab = byId.get(entry.id);
      return { ...entry, label: tab.title || `Game ${entry.slot}`, origin: new URL(tab.url).origin,
        playerOrigins: [...new Set((playerOriginsByTab[tab.id] || entry.playerOrigins || []).filter((origin) => origin !== new URL(tab.url).origin))] };
    });
    const keepMap = (value) => Object.fromEntries(Object.entries(value || {}).filter(([id]) => ids.includes(Number(id))));
    const targetId = ids.includes(old.activeId) ? old.activeId : ids.includes(old.lastGameId) ? old.lastGameId : nextTabs[0].id;
    session = { ...old, tabs: nextTabs, originalMute: new Map(old.originalMute),
      gameMuteChoices: keepMap(old.gameMuteChoices), mutedByTab: { ...old.mutedByTab },
      fullscreenByTab: keepMap(old.fullscreenByTab), autoOptOutByTab: keepMap(old.autoOptOutByTab),
      previousId: ids.includes(old.previousId) ? old.previousId : null };
    try {
      await captureAndMuteOthers(targetId);
    } catch (error) {
      session = old;
      await Promise.allSettled(staged.map(cleanMember));
      const previous = old.activeId || old.lastGameId;
      if (previous && byId.has(previous)) await captureAndMuteOthers(previous).catch(() => {});
      await persistSession();
      await broadcastState();
      throw error;
    }
    await Promise.allSettled(old.tabs.filter((tab) => !ids.includes(tab.id)).map((tab) => cleanMember(tab.id)));
    await broadcastState();
    diagnostics.record("edits");
    diagnostics.size?.(nextTabs.length);
    return { ok: true, ...stateFor(targetId) };
  }

  async function watchGame(tabId) {
    if (!session || !session.tabs.some((tab) => tab.id === tabId)) throw new Error("Choose a game in your running lineup.");
    await captureAndMuteOthers(tabId);
    await broadcastState();
    await browser.tabs.sendMessage(tabId, { type: "CZ_READY_PLAYER" }).catch(() => {});
    return { ok: true };
  }

  async function getTabState(tabId) {
    return stateFor(tabId);
  }

  function queueFullscreenCandidate(tabId, frameId, kind, automatic = false) {
    if (!candidateBatches.has(tabId)) candidateBatches.set(tabId, new Map());
    const batch = candidateBatches.get(tabId);
    batch.set(`${frameId}:${kind}:${automatic}`, { frameId, kind, automatic });
    if (batch.scheduled) return;
    batch.scheduled = true;
    setTimeout(() => {
      const candidates = [...batch.values()];
      candidateBatches.delete(tabId);
      enqueue(() => runFullscreenTransaction(tabId, candidates)).catch(() => diagnostics.failure("fullscreen"));
    }, 0);
  }

  function sendFrameMessage(tabId, frameId, message) {
    return browser.tabs.sendMessage(tabId, message, { frameId });
  }

  async function warnFullscreen(tabId, warning) {
    if (!session) return;
    diagnostics.failure("fullscreen");
    session.warning = warning;
    await persistSession();
    await browser.tabs.sendMessage(tabId, { type: "CZ_FS_WARNING", warning }, { frameId: 0 }).catch(() => {});
    await broadcastState();
  }

  async function runFullscreenTransaction(tabId, candidates) {
    await ensureReady();
    if (!session || !session.tabs.some((tab) => tab.id === tabId) || !candidates.length) return;
    const active = await browser.tabs.query({ active: true, windowId: session.windowId });
    if (active[0]?.id !== tabId || session.activeId !== tabId) return;
    session.autoOptOutByTab ||= {};
    const automatic = candidates.some((item) => item.automatic === true);
    const operationCandidates = candidates.filter((item) => item.automatic === automatic);
    if (automatic && (session.autoOptOutByTab[tabId] || operationCandidates.some((item) => item.kind !== "video"))) return;
    const member = session.tabs.find((tab) => tab.id === tabId);
    if (typeof browser.webNavigation?.getAllFrames !== "function") {
      return warnFullscreen(tabId, "Player inspection is unavailable. Restart the browser and CraigZone. Native fullscreen remains active.");
    }
    const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => []);
    const byId = new Map((frames || []).map((frame) => [frame.frameId, frame]));
    for (const candidate of operationCandidates) {
      if (candidate.frameId !== 0 || candidate.kind !== "iframe") continue;
      const reachablePlayer = candidates.some((other) => {
        if (other.frameId === 0 || other.kind === "iframe") return false;
        let frame = byId.get(other.frameId);
        while (frame && frame.frameId !== 0) frame = byId.get(frame.parentFrameId);
        return frame?.frameId === 0;
      });
      if (!reachablePlayer) return warnFullscreen(tabId, "CraigZone could not verify a reachable player inside the fullscreen iframe. Native fullscreen remains active.");
    }
    const depth = (candidate) => {
      let frame = byId.get(candidate.frameId);
      let value = 0;
      while (frame && frame.frameId !== 0) {
        value += 1;
        frame = byId.get(frame.parentFrameId);
      }
      return frame?.frameId === 0 ? value : -1;
    };
    const candidate = [...operationCandidates]
      .filter((item) => depth(item) >= 0)
      .sort((a, b) => depth(b) - depth(a) || (a.kind === "iframe" ? 1 : 0) - (b.kind === "iframe" ? 1 : 0))[0];
    if (!candidate) return warnFullscreen(tabId, "The player frame could not be verified. Native fullscreen remains active.");
    const token = `${Date.now()}-${candidate.frameId}-${Math.random().toString(36).slice(2)}`;
    const chain = [];
    let current = byId.get(candidate.frameId);
    let child = null;
    while (current) {
      const origin = /^https?:/.test(current.url || "") ? new URL(current.url).origin : "";
      if (!origin) return warnFullscreen(tabId, "The player frame uses an unsupported site. Native fullscreen remains active.");
      if (origin !== member.origin && !member.playerOrigins.includes(origin)) {
        return warnFullscreen(tabId, `Player site ${origin} is missing permission. Native fullscreen remains active.`);
      }
      chain.push({
        frameId: current.frameId,
        role: current.frameId === candidate.frameId ? "candidate" : "ancestor",
        candidateFrameId: candidate.frameId,
        candidateKind: candidate.kind,
        automatic,
        childFrameId: child?.frameId,
        childUrl: child?.url
      });
      if (current.frameId === 0) break;
      child = current;
      current = byId.get(current.parentFrameId);
    }
    if (!chain.length || chain.at(-1).frameId !== 0) return warnFullscreen(tabId, "The complete player frame chain is unavailable. Native fullscreen remains active.");
    const steps = chain.map((step) => ({ ...step, token }));
    const prepared = await Promise.all(steps.map(async (step) => {
      try {
        const response = await sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_PREPARE", ...step });
        return { step, response };
      } catch (error) {
        return { step, response: { ready: false, reason: error.message || String(error) } };
      }
    }));
    const failed = prepared.find(({ response }) => response?.ready !== true);
    if (failed) {
      await Promise.allSettled(steps.map((step) => sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_ABORT", token: step.token })));
      return warnFullscreen(tabId, `CraigZone cannot reach every player frame (${failed.response?.reason || "frame did not respond"}). Native fullscreen remains active.`);
    }
    for (const step of steps) {
      let staged;
      try { staged = await sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_STAGE", ...step }); }
      catch (error) { staged = { ok: false, reason: error.message || String(error) }; }
      if (staged?.ok !== true) {
        await Promise.allSettled(steps.map((item) => sendFrameMessage(tabId, item.frameId, { type: "CZ_FS_ABORT", token: item.token })));
        return warnFullscreen(tabId, `CraigZone could not stage the complete player chain (${staged?.reason || "frame did not respond"}). Native fullscreen remains active.`);
      }
    }
    if (!automatic) {
      let exited;
      try { exited = await sendFrameMessage(tabId, 0, { type: "CZ_FS_EXIT", token }); }
      catch (error) { exited = { ok: false, reason: error.message || String(error) }; }
      if (exited?.ok !== true) {
        await Promise.allSettled(steps.map((step) => sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_ABORT", token: step.token })));
        return warnFullscreen(tabId, `CraigZone could not leave player fullscreen (${exited?.reason || "top frame did not respond"}). Native fullscreen remains active.`);
      }
    }
    for (const step of steps) {
      let applied;
      try { applied = await sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_APPLY", ...step }); }
      catch (error) { applied = { ok: false, reason: error.message || String(error) }; }
      if (applied?.ok !== true) {
        await Promise.allSettled(steps.map((item) => sendFrameMessage(tabId, item.frameId, { type: "CZ_FS_ABORT", token: item.token })));
        return warnFullscreen(tabId, `CraigZone could not expand the complete player chain (${applied?.reason || "frame did not respond"}).`);
      }
    }
    session.fullscreenByTab ||= {};
    session.fullscreenByTab[tabId] = { tabId, tokens: [token], steps, originalWindowState: session.originalWindowState };
    session.warning = "";
    try {
      await browser.windows.update(session.windowId, { state: "fullscreen" });
    } catch (error) {
      await Promise.allSettled(steps.map((step) => sendFrameMessage(tabId, step.frameId, { type: "CZ_FS_ABORT", token })));
      delete session.fullscreenByTab[tabId];
      return warnFullscreen(tabId, `CraigZone could not switch the Firefox window to fullscreen (${error.message || String(error)}). Player layout was restored.`);
    }
    if (!automatic) delete session.autoOptOutByTab[tabId];
    await persistSession();
    await broadcastState();
    diagnostics.record("fullscreen");
  }

  async function restoreFullscreen(tabId, token, optOut = false, nativeExit = false) {
    const requested = session?.fullscreenByTab?.[tabId];
    if (!requested || !requested.tokens.includes(token)) return { ok: false };
    if (optOut) {
      session.autoOptOutByTab ||= {};
      session.autoOptOutByTab[tabId] = true;
    }
    const operations = Object.values(session.fullscreenByTab);
    let nativeExitWarning = "";
    if (nativeExit) {
      const top = requested.steps.find((step) => step.frameId === 0);
      if (top) {
        try {
          const result = await sendFrameMessage(tabId, 0, { type: "CZ_FS_NATIVE_EXIT", token });
          if (result?.ok !== true) nativeExitWarning = result?.reason || "top frame did not respond";
        } catch (error) { nativeExitWarning = error.message || String(error); }
      } else nativeExitWarning = "top frame is unavailable";
    }
    const restores = operations.flatMap((operation) => {
      const unique = new Map(operation.steps.map((step) => [`${operation.tabId}:${step.frameId}:${step.token}`, step]));
      return [...unique.values()].map((step) => sendFrameMessage(operation.tabId, step.frameId, { type: "CZ_FS_RESTORE", token: step.token }));
    });
    await Promise.allSettled(restores);
    session.fullscreenByTab = {};
    session.warning = nativeExitWarning
      ? `CraigZone restored the browser layout, but player fullscreen could not be exited (${nativeExitWarning}).`
      : "";
    await browser.windows.update(session.windowId, { state: session.originalWindowState || "normal" }).catch(() => {});
    await persistSession();
    await broadcastState();
    return { ok: true };
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (["CZ_START", "CZ_UPDATE_SESSION", "CZ_WATCH_GAME"].includes(message.type)) {
      const extensionUrl = browser.runtime.getURL("");
      if (sender.tab || !sender.url?.startsWith(extensionUrl)) return undefined;
      return enqueue(async () => {
        await ensureReady();
        if (message.type === "CZ_UPDATE_SESSION") return updateSession(message.ids, message.windowId, message.playerOriginsByTab);
        if (message.type === "CZ_WATCH_GAME") return watchGame(message.tabId);
        return startSession(message.ids, message.windowId, message.playerOriginsByTab);
      })
        .then((result) => ({ ...result }))
        .catch((error) => { diagnostics.failure(message.type === "CZ_UPDATE_SESSION" ? "edit" : "start"); return { ok: false, error: error.message || String(error) }; });
    }
    if (message.type === "CZ_STOP_SESSION") {
      const extensionUrl = browser.runtime.getURL("");
      if (sender.tab || !sender.url?.startsWith(extensionUrl)) return undefined;
      return enqueue(async () => { await ensureReady(); return stopSession(); }).then((result) => ({ ...result }))
        .catch(() => { diagnostics.failure("stop"); return { ok: false }; });
    }
    if (message.type === "CZ_GET_SESSION") {
      const extensionUrl = browser.runtime.getURL("");
      if (sender.tab || !sender.url?.startsWith(extensionUrl)) return undefined;
      return ensureReady().then(() => ({
        enabled: Boolean(session && !session.stopping),
        tabs: session?.tabs.map(({ id, slot, label, playerOrigins }) => ({ id, slot, label, playerOrigins })) || [],
        activeId: session?.activeId ?? null,
        lastGameId: session?.lastGameId ?? null,
        mutedByTab: session?.mutedByTab || {},
        windowId: session?.windowId ?? null,
        warning: session?.warning || ""
      }));
    }
    if (["CZ_DIAGNOSTICS_GET", "CZ_DIAGNOSTICS_CLEAR", "CZ_PERMISSION_RESULT"].includes(message.type)) {
      const extensionUrl = browser.runtime.getURL("");
      if (sender.tab || !sender.url?.startsWith(extensionUrl)) return undefined;
      if (message.type === "CZ_PERMISSION_RESULT") {
        diagnostics.permission?.(message.outcome);
        return Promise.resolve({ ok: true });
      }
      return message.type === "CZ_DIAGNOSTICS_CLEAR" ? diagnostics.clear() : diagnostics.get();
    }
    if (message.type === "CZ_FS_CANDIDATE") {
      const tabId = sender.tab?.id;
      if (tabId == null || !["video", "container-video", "iframe", "other"].includes(message.kind)) return undefined;
      queueFullscreenCandidate(tabId, sender.frameId ?? 0, message.kind, message.automatic === true);
      return undefined;
    }
    if (message.type === "CZ_FS_RESTORE_REQUEST") {
      const tabId = sender.tab?.id;
      if (tabId == null) return undefined;
      return enqueue(async () => {
        await ensureReady();
        const active = await browser.tabs.query({ active: true, windowId: session?.windowId });
        if (!session || active[0]?.id !== tabId || session.activeId !== tabId) return { ok: false };
        return restoreFullscreen(tabId, message.token, message.optOut === true, message.nativeExit === true);
      });
    }
    if (message.type === "CZ_FS_CHECK_WINDOW") {
      const tabId = sender.tab?.id;
      if (tabId == null) return undefined;
      return enqueue(async () => {
        await ensureReady();
        if (!session || !session.tabs.some((tab) => tab.id === tabId)) return { ok: false };
        const active = await browser.tabs.query({ active: true, windowId: session.windowId });
        if (active[0]?.id !== tabId) return { ok: false };
        const current = await browser.windows.get(session.windowId).catch(() => null);
        if (current && current.state !== "fullscreen") {
          const operation = Object.values(session.fullscreenByTab || {})[0];
          if (operation) return restoreFullscreen(operation.tabId, operation.tokens[0]);
        }
        return { ok: true };
      });
    }
    if (["CZ_KEY", "CZ_STATE"].includes(message.type)) {
      const tabId = sender.tab?.id;
      if (tabId == null) return undefined;
      if (message.type === "CZ_STATE") return ensureReady().then(async () => {
        if (!session || !session.tabs.some((tab) => tab.id === tabId)) return undefined;
        const state = await getTabState(tabId);
        return { type: "CZ_STATE", ...state };
      });
      return enqueue(async () => {
        await ensureReady();
        const active = await browser.tabs.query({ active: true, windowId: session?.windowId });
        if (!session || active[0]?.id !== tabId || session.activeId !== tabId) return { ok: false };
        if (message.action === "mute") return toggleActiveMute(tabId);
        if (message.action === "slot" && Number.isInteger(message.slot) && message.slot >= 1 && message.slot <= MAX_SLOTS) {
          const index = session.tabs.findIndex((tab) => tab.slot === message.slot);
          if (index >= 0) {
            const oldId = session.activeId;
            const result = await selectIndex(index);
            if (result) { session.previousId = oldId; await persistSession(); }
            return { ok: result };
          }
          return { ok: false };
        }
        if (!["next", "previous", "last"].includes(message.action)) return { ok: false };
        return { ok: await move(message.action) };
      }).catch(() => { diagnostics.failure(message.action === "mute" ? "mute" : "switch"); return { ok: false }; });
    }
    return undefined;
  });

  browser.commands.onCommand.addListener((command) => {
    if (command === "open-controls") { browser.action.openPopup().catch(() => {}); return; }
    if (command === "toggle") {
      if (session) enqueue(async () => { await ensureReady(); return stopSession(); }).catch(() => diagnostics.failure("stop"));
      else browser.action.openPopup().catch(() => {});
      return;
    }
    const action = command === "next" ? "next" : command === "previous" ? "previous" : command === "last" ? "last" : null;
    if (action) enqueue(async () => { await ensureReady(); return move(action); }).catch(() => diagnostics.failure("switch"));
  });

  browser.tabs.onRemoved.addListener((tabId, info) => {
    enqueue(async () => {
      await ensureReady();
      if (!session || info.windowId !== session.windowId) return;
      const wasActive = session?.activeId === tabId;
      session.tabs = session.tabs.filter((tab) => tab.id !== tabId);
      session.originalMute.delete(tabId);
      if (session.mutedByTab) delete session.mutedByTab[tabId];
      if (session.gameMuteChoices) delete session.gameMuteChoices[tabId];
      if (session.autoOptOutByTab) delete session.autoOptOutByTab[tabId];
      if (session.fullscreenByTab) delete session.fullscreenByTab[tabId];
      if (session.previousId === tabId) session.previousId = null;
      await persistSession();
      if (!session.tabs.length) return stopSession();
      if (wasActive) {
        await selectIndex(0);
      }
      await broadcastState();
    }).catch(() => {});
  });

  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    enqueue(async () => {
      await ensureReady();
      if (!session || windowId !== session.windowId) return;
      const actuallyActive = await browser.tabs.query({ active: true, windowId });
      if (actuallyActive[0]?.id !== tabId) return;
      if (actuallyActive[0]?.url === browser.runtime.getURL("popup.html")) {
        await broadcastState();
        return;
      }
      if (!session.tabs.some((tab) => tab.id === tabId)) {
        const tabs = await browser.tabs.query({ windowId: session.windowId });
        session.mutedByTab ||= {};
        for (const tab of tabs) {
          if (!session.originalMute.has(tab.id)) session.originalMute.set(tab.id, Boolean(tab.mutedInfo?.muted));
        }
        await persistSession();
        for (const tab of tabs) if (!tab.mutedInfo?.muted) await browser.tabs.update(tab.id, { muted: true });
        for (const tab of tabs) session.mutedByTab[tab.id] = true;
        session.activeId = null;
        await persistSession();
        await broadcastState();
        return;
      }
      const previous = session.activeId;
      if (previous != null && previous !== tabId) session.previousId = previous;
      await captureAndMuteOthers(tabId);
      if (previous !== tabId) await persistSession();
      await broadcastState();
    }).catch(() => {});
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.mutedInfo?.muted === false) silenceOtherTab(tab);
    else if (typeof changeInfo.mutedInfo?.muted === "boolean") {
      enqueue(async () => {
        await ensureReady();
        if (!session || tab.id !== session.activeId || !session.tabs.some((member) => member.id === tabId)) return;
        session.mutedByTab ||= {};
        session.mutedByTab[tabId] = changeInfo.mutedInfo.muted;
        session.gameMuteChoices ||= {};
        session.gameMuteChoices[tabId] = changeInfo.mutedInfo.muted;
        await persistSession();
        await broadcastState();
      }).catch(() => {});
    }
    if (changeInfo.status !== "complete") return;
    enqueue(async () => {
      await ensureReady();
      if (!session) return;
      const member = session.tabs.find((entry) => entry.id === tabId);
      if (!member) return;
      if (!/^https?:/.test(tab.url || "")) {
        session.warning = "A selected tab navigated to a restricted page. Restart from the toolbar after returning to an HTTP or HTTPS page.";
        await persistSession();
        await broadcastState();
        return;
      }
      const parsed = new URL(tab.url);
      const origin = `${parsed.protocol}//${parsed.hostname}/*`;
      if (!await browser.permissions.contains({ origins: [origin] })) {
        session.warning = "A selected tab changed site and needs permission. Use the toolbar to restart CraigZone.";
        await persistSession();
        await broadcastState();
        return;
      }
      member.label = tab.title || tab.url;
      const result = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
      await browser.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ["content.css"] });
      const failures = Array.isArray(result) ? result.filter((frame) => frame.error).length : 0;
      session.warning = failures ? `CraigZone could not reach ${failures} embedded frame${failures === 1 ? "" : "s"}. Enable the listed frame origins in the toolbar and restart.` : "";
      await persistSession();
      await broadcastState();
    }).catch((error) => {
      if (session) { session.warning = error.message || String(error); persistSession().catch(() => {}); }
    });
  });

  let frameNavigationListenerInstalled = false;
  function installFrameNavigationListener() {
    if (frameNavigationListenerInstalled || !browser.webNavigation?.onCompleted) return;
    try {
      browser.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId === 0) return;
        enqueue(async () => {
          await ensureReady();
          if (!session) return;
          const member = session.tabs.find((entry) => entry.id === details.tabId);
          if (!member) return;
          const origin = /^https?:/.test(details.url || "") ? new URL(details.url).origin : "";
          if (!origin) return;
          if (origin !== member.origin && !member.playerOrigins.includes(origin)) {
            await warnFullscreen(details.tabId, `Slot ${member.slot} loaded a player at ${origin}. Stop and restart CraigZone to approve this player site.`);
            return;
          }
          const originGranted = await browser.permissions.contains({ origins: [matchPattern(details.url)] });
          if (!originGranted) return warnFullscreen(details.tabId, `Slot ${member.slot} player site ${origin} needs permission.`);
          const target = { tabId: details.tabId, frameIds: [details.frameId] };
          const result = await browser.scripting.executeScript({ target, files: ["content.js"] });
          const errors = Array.isArray(result) ? result.filter((entry) => entry.error) : [];
          if (errors.length) return warnFullscreen(details.tabId, `Slot ${member.slot} player frame ${origin} could not be reached.`);
          await browser.scripting.insertCSS({ target, files: ["content.css"] });
        }).catch((error) => warnFullscreen(details.tabId, error.message || String(error)));
      });
      frameNavigationListenerInstalled = true;
    } catch (_) { /* Optional webNavigation access is installed when the user grants it. */ }
  }

  browser.permissions.onAdded.addListener((permissions) => {
    if (permissions.permissions?.includes("webNavigation")) installFrameNavigationListener();
  });

  function silenceOtherTab(tab) {
    enqueue(async () => {
      await ensureReady();
      if (!session || tab.windowId !== session.windowId || tab.id === session.activeId) return;
      if (!session.originalMute.has(tab.id)) {
        session.originalMute.set(tab.id, Boolean(tab.mutedInfo?.muted));
        await persistSession();
      }
      await browser.tabs.update(tab.id, { muted: true });
      session.mutedByTab ||= {};
      session.mutedByTab[tab.id] = true;
      await persistSession();
    }).catch(() => {});
  }
  browser.tabs.onCreated.addListener(silenceOtherTab);

  installFrameNavigationListener();
  ensureReady();

  if (typeof module !== "undefined") module.exports = {
    _setSession: (value) => { session = value; },
    _resetReadyForTest: () => { readyPromise = null; },
    _stateFor: stateFor,
    _ensureReady: ensureReady
  };
})();
