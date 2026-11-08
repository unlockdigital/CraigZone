/* global browser */
(() => {
  const list = document.getElementById("tabs");
  const status = document.getElementById("status");
  const errorBox = document.getElementById("error");
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");
  const frameOriginsLabel = document.getElementById("frame-origins");
  const version = document.getElementById("version");
  const startButton = document.getElementById("start");
  const stopButton = document.getElementById("stop");
  const diagnosticsSummary = document.getElementById("diagnostics-summary");
  const clearDiagnosticsButton = document.getElementById("clear-diagnostics");
  const editButton = document.getElementById("edit-games");
  const cancelEditButton = document.getElementById("cancel-edit");
  const playerAccess = document.getElementById("player-access");
  let editing = false;
  const MIN_SLOTS = 2;
  const MAX_SLOTS = 9;
  let tabs = [];
  let session = null;
  let pendingStart = null;
  let hasRendered = false;
  let startBusy = false;
  let refreshTimer = null;
  let refreshNeeded = false;
  let liveRefreshRunning = false;
  let ownerWindowId = null;
  version.textContent = `Version ${browser.runtime.getManifest().version}`;
  document.getElementById("browser-name").textContent = browser.runtime.getURL("").startsWith("chrome-extension:") ? "Chromium" : "Firefox";
  browser.tabs.getCurrent().then((tab) => { if (tab) document.body.classList.add("full-page"); }).catch(() => {});
  document.getElementById("open-full-controls").addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("popup.html") });
  });

  function setError(message = "") {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function selectedIds() {
    return [...list.querySelectorAll("input:checked")].map((input) => Number(input.value));
  }

  function updateCount() {
    const ids = selectedIds();
    count.textContent = `${ids.length} / 9`;
    for (const input of list.querySelectorAll("input")) input.disabled = startBusy || (Boolean(session) && !editing) || (!input.checked && ids.length >= 9);
    startButton.disabled = startBusy || ids.length < (session ? 1 : MIN_SLOTS) || ids.length > MAX_SLOTS;
  }

  function makeRow(tab, checked, slot) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(tab.id);
    input.checked = checked;
    input.addEventListener("change", updateCount);
    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || new URL(tab.url).hostname;
    const url = document.createElement("span");
    url.className = "tab-url";
    url.textContent = new URL(tab.url).host;
    copy.append(title, url);
    const position = document.createElement("span");
    position.className = "slot";
    position.textContent = slot ? `#${slot}` : "";
    label.append(input, copy, position);
    li.append(label);
    if (slot && session && !editing) {
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "secondary watch-game";
      watch.textContent = session.activeId === tab.id ? (session.mutedByTab?.[tab.id] ? "Muted" : "Watching") : "Watch";
      watch.setAttribute("aria-label", `Watch game ${slot}: ${tab.title || "Game"}`);
      watch.addEventListener("click", async () => {
        watch.disabled = true;
        const result = await browser.runtime.sendMessage({ type: "CZ_WATCH_GAME", tabId: tab.id });
        if (!result?.ok) { setError(result?.error || "That game is unavailable."); watch.disabled = false; }
        else if (!document.body.classList.contains("full-page")) window.close?.();
      });
      li.append(watch);
      if (session.activeId === tab.id || session.lastGameId === tab.id) li.classList.add("active-game");
    }
    return li;
  }

  async function render({ live = false } = {}) {
    if (ownerWindowId == null) ownerWindowId = (await browser.windows.getCurrent()).id;
    const active = await browser.tabs.query({ active: true, windowId: ownerWindowId });
    const activeId = active[0]?.id;
    const [all, current] = await Promise.all([
      browser.tabs.query({ windowId: ownerWindowId }),
      browser.runtime.sendMessage({ type: "CZ_GET_SESSION" })
    ]);
    if (live && startBusy) { refreshNeeded = true; return; }
    const selection = live && hasRendered ? new Set(selectedIds()) : null;
    const nextTabs = all.filter((tab) => /^https?:/.test(tab.url || ""));
    const oldById = new Map(tabs.map((tab) => [tab.id, tab]));
    const nextById = new Map(nextTabs.map((tab) => [tab.id, tab]));
    const keepPlan = live && pendingStart && pendingStart.mode === (current.enabled ? "update" : "start") && pendingStart.ids.every((id) =>
      oldById.get(id)?.url === nextById.get(id)?.url && nextById.has(id));
    if (!keepPlan) {
      setError();
      pendingStart = null;
      startButton.textContent = current.enabled ? "Check players and apply" : "Check players and start";
    }
    session = current.enabled ? current : null;
    if (!session) editing = false;
    tabs = nextTabs;
    list.replaceChildren();
    const memberSlots = new Map((session?.tabs || []).map((tab) => [tab.id, tab.slot]));
    const selected = new Set(editing && selection ? selection : session?.tabs.map((tab) => tab.id) || selection || [activeId]);
    if (session) {
      const order = new Map(session.tabs.map((tab, index) => [tab.id, index]));
      tabs.sort((a, b) => (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100));
    }
    tabs.forEach((tab) => list.append(makeRow(tab, selected.has(tab.id), memberSlots.get(tab.id))));
    empty.hidden = tabs.length > 0;
    startButton.hidden = Boolean(session) && !editing;
    stopButton.hidden = !session || editing;
    editButton.hidden = !session || editing;
    cancelEditButton.hidden = !editing;
    document.getElementById("list-heading").textContent = editing ? "Edit 1–9 games · slots stay with your games" : session ? "Your running games" : "Choose 2–9 game tabs";
    if (session) {
      const summaries = session.tabs.map((tab) => `#${tab.slot} ${tab.label}: ${tab.playerOrigins?.length || 0} player site${tab.playerOrigins?.length === 1 ? "" : "s"} ready`);
      status.textContent = session.warning || (editing ? "Choose games to add or remove, then apply. Your session stays running." : `Running · ${session.tabs.length} game${session.tabs.length === 1 ? "" : "s"}. Choose Watch to return to a game, or Edit games to change the lineup.`);
      frameOriginsLabel.textContent = session.tabs.map((tab) => `#${tab.slot}: ${(tab.playerOrigins || []).join(", ") || "page origin only"}`).join("\n");
    } else if (!keepPlan) {
      status.textContent = "Ready. Choose your games, start CraigZone, then click Play.";
      frameOriginsLabel.textContent = "Start checks only the selected tabs and their embedded players. Firefox may ask for access to additional player sites before controls start.";
    }
    hasRendered = true;
    updateCount();
  }

  function scheduleLiveRefresh() {
    refreshNeeded = true;
    if (startBusy || liveRefreshRunning || refreshTimer != null) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (startBusy) return;
      refreshNeeded = false;
      liveRefreshRunning = true;
      try { await render({ live: true }); }
      catch (_) { /* A closing browser may invalidate this controls page. */ }
      finally {
        liveRefreshRunning = false;
        if (refreshNeeded) scheduleLiveRefresh();
      }
    }, 120);
  }

  const belongsHere = (windowId) => ownerWindowId == null || windowId === ownerWindowId;
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "CZ_SESSION_CHANGED") scheduleLiveRefresh();
  });
  browser.tabs.onCreated.addListener((tab) => { if (belongsHere(tab.windowId)) scheduleLiveRefresh(); });
  browser.tabs.onRemoved.addListener((_id, info) => { if (belongsHere(info.windowId)) scheduleLiveRefresh(); });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (!belongsHere(tab.windowId) || !(change.url || change.title || change.status)) return;
    if (pendingStart?.ids.includes(id) && (change.url || change.status === "loading")) pendingStart = null;
    scheduleLiveRefresh();
  });
  for (const event of [browser.tabs.onMoved, browser.tabs.onAttached, browser.tabs.onDetached]) {
    event?.addListener(() => scheduleLiveRefresh());
  }

  async function renderDiagnostics() {
    const data = await browser.runtime.sendMessage({ type: "CZ_DIAGNOSTICS_GET" });
    const totals = { switches: 0, mutes: 0, starts: 0, stops: 0, fullscreen: 0, edits: 0, failures: 0 };
    for (const row of Object.values(data?.days || {})) {
      for (const key of Object.keys(totals).filter((name) => name !== "failures")) totals[key] += row.actions?.[key] || 0;
      totals.failures += Object.values(row.failures || {}).reduce((sum, n) => sum + n, 0);
    }
    const dates = Object.keys(data?.days || {}).sort();
    diagnosticsSummary.textContent = `${dates.length ? dates[0] + "–" + dates.at(-1) + " UTC" : "No retained activity"}: ${totals.switches} switches · ${totals.mutes} mutes · ${totals.starts} starts · ${totals.edits} lineup edits · ${totals.fullscreen} fullscreen · ${totals.failures} recorded errors. Retention: 7 UTC days.`;
    const status = data?.status || {};
    const updated = data?.updatedAt ? new Date(data.updatedAt).toLocaleString() : "unknown for earlier counts";
    document.getElementById("diagnostics-status").textContent = `Build ${status.build || "unknown"} · ${status.browser || "unknown browser"}. Last activity: ${updated}. Local mirror: ${status.mirror || "unknown"}${status.lastMirrorAt ? " · confirmed " + new Date(status.lastMirrorAt).toLocaleString() : ""}.`;
  }

  clearDiagnosticsButton.addEventListener("click", async () => {
    clearDiagnosticsButton.disabled = true;
    try {
      const result = await browser.runtime.sendMessage({ type: "CZ_DIAGNOSTICS_CLEAR" });
      await renderDiagnostics();
      diagnosticsSummary.textContent = result?.storageCleared
        ? (result?.mirrorCleared ? "Diagnostics cleared from this browser and the local mirror." : "Browser diagnostics cleared. The local mirror could not be confirmed.")
        : "CraigZone could not confirm clearing browser diagnostics.";
    } catch (_) {
      diagnosticsSummary.textContent = "CraigZone could not confirm clearing diagnostics.";
    } finally { clearDiagnosticsButton.disabled = false; }
  });
  document.getElementById("export-diagnostics").addEventListener("click", async () => {
    const data = await browser.runtime.sendMessage({ type: "CZ_DIAGNOSTICS_GET" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `craig-zone-local-summary-${new Date().toISOString().slice(0,10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  editButton.addEventListener("click", async () => { editing = true; pendingStart = null; await render(); });
  cancelEditButton.addEventListener("click", async () => { editing = false; pendingStart = null; await render(); });

  function originPattern(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("CraigZone can access HTTP and HTTPS player sites only.");
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  async function inspectSelectedTabs(ids, windowId) {
    if (typeof browser.webNavigation?.getAllFrames !== "function") {
      throw new Error("Player inspection is unavailable. Close and reopen the browser, then open CraigZone again. If this continues, use CraigZone Help to check the extension.");
    }
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const originsByTab = {};
    const frameUrls = await Promise.all(ids.map(async (id) => {
      try {
        const frames = await browser.webNavigation.getAllFrames({ tabId: id });
        return [id, (frames || []).map((frame) => frame.url).filter((url) => /^https?:/.test(url))];
      } catch (error) {
        throw new Error(`Could not inspect embedded players in ${byId.get(id)?.title || "a selected tab"}: ${error.message || error}`);
      }
    }));
    const byFrame = new Map(frameUrls);
    const topPatterns = ids.map((id) => originPattern(byId.get(id).url));
    const framePatterns = [];
    for (const id of ids) {
      const topOrigin = new URL(byId.get(id).url).origin;
      const origins = [...new Set((byFrame.get(id) || []).map((url) => new URL(url).origin))]
        .filter((origin) => origin !== topOrigin);
      originsByTab[id] = origins;
      framePatterns.push(...origins.map(originPattern));
    }
    const allPatterns = [...new Set([...topPatterns, ...framePatterns])];
    const checks = await Promise.all(allPatterns.map(async (origin) => [origin, await browser.permissions.contains({ origins: [origin] })]));
    const missingTop = checks.filter(([origin, granted]) => !granted && topPatterns.includes(origin)).map(([origin]) => origin);
    if (missingTop.length) throw new Error(`Firefox has not granted the selected page origins: ${missingTop.join(", ")}`);
    const missingFrames = checks.filter(([origin, granted]) => !granted && framePatterns.includes(origin)).map(([origin]) => origin);
    return { ids, windowId, originsByTab, framePatterns: [...new Set(framePatterns)], missingFrames };
  }

  async function launchSession(plan) {
    const result = await browser.runtime.sendMessage({
      type: plan.mode === "update" ? "CZ_UPDATE_SESSION" : "CZ_START", ids: plan.ids, windowId: plan.windowId, playerOriginsByTab: plan.originsByTab
    });
    if (!result?.ok) throw new Error(result?.error || "CraigZone could not start.");
    editing = false;
    await render();
    await renderDiagnostics();
  }

  startButton.addEventListener("click", async () => {
    setError();
    const ids = selectedIds();
    if (!pendingStart && (ids.length < (session ? 1 : MIN_SLOTS) || ids.length > MAX_SLOTS)) return setError(session ? "Keep at least one game, up to nine." : "Choose at least two game tabs, up to nine.");
    if (startBusy) return;
    startBusy = true;
    updateCount();
    try {
      if (!pendingStart) {
        const topOrigins = [...new Set(ids.map((id) => originPattern(tabs.find((tab) => tab.id === id).url)))];
        const permissionRequest = browser.permissions.request({ permissions: ["webNavigation"], origins: topOrigins }).catch(async (error) => {
          await browser.runtime.sendMessage({ type: "CZ_PERMISSION_RESULT", outcome: "failed" }).catch(() => {});
          throw error;
        });
        const granted = await permissionRequest;
        await browser.runtime.sendMessage({ type: "CZ_PERMISSION_RESULT", outcome: granted ? "granted" : "denied" });
        if (!granted) throw new Error("CraigZone needs access to the selected pages and their frame list before it can start.");
        const current = await browser.runtime.sendMessage({ type: "CZ_GET_SESSION" });
        session = current.enabled ? current : null;
        const windowId = (await browser.windows.getCurrent()).id;
        const plan = await inspectSelectedTabs(ids, windowId);
        plan.mode = session ? "update" : "start";
        if (plan.missingFrames.length) {
          pendingStart = plan;
          startButton.disabled = false;
          startButton.textContent = session ? "Enable player sites and apply" : "Enable player sites and start";
          playerAccess.open = true;
          frameOriginsLabel.textContent = `Detected player sites: ${plan.framePatterns.map((pattern) => pattern.replace(/\/\*$/, "")).join(", ") || "same origin as each selected page"}. Firefox will ask for access to: ${plan.missingFrames.map((pattern) => pattern.replace(/\/\*$/, "")).join(", ")}`;
          status.textContent = session ? "Approve the new player sites to apply your lineup. Current games stay running." : "Player sites are ready for approval. Click Enable player sites and start.";
          return;
        }
        await launchSession(plan);
      } else {
        const plan = pendingStart;
        const permissionRequest = browser.permissions.request({ origins: plan.missingFrames }).catch(async (error) => {
          await browser.runtime.sendMessage({ type: "CZ_PERMISSION_RESULT", outcome: "failed" }).catch(() => {});
          throw error;
        });
        const granted = await permissionRequest;
        await browser.runtime.sendMessage({ type: "CZ_PERMISSION_RESULT", outcome: granted ? "granted" : "denied" });
        if (!granted) throw new Error("Firefox did not grant every detected player site. CraigZone remains stopped.");
        const checks = await Promise.all(plan.framePatterns.map(async (origin) => [origin, await browser.permissions.contains({ origins: [origin] })]));
        const missing = checks.filter(([, allowed]) => !allowed).map(([origin]) => origin);
        if (missing.length) throw new Error(`Player access remains incomplete: ${missing.join(", ")}`);
        await launchSession(plan);
      }
    } catch (error) {
      setError(error.message || String(error));
      startButton.disabled = false;
    } finally {
      startBusy = false;
      updateCount();
      if (refreshNeeded) scheduleLiveRefresh();
    }
  });

  stopButton.addEventListener("click", async () => {
    stopButton.disabled = true;
    setError();
    try {
      await browser.runtime.sendMessage({ type: "CZ_STOP_SESSION" });
      await render();
    } catch (error) {
      setError(error.message || String(error));
    } finally {
      stopButton.disabled = false;
    }
  });

  list.addEventListener("change", () => {
    pendingStart = null;
    startButton.textContent = session ? "Check players and apply" : "Check players and start";
    updateCount();
  });

  render().catch((error) => setError(error.message || String(error)));
  renderDiagnostics().catch(() => {});
})();
