(() => {
  'use strict';

  // Content scripts may be registered for every frame. Keep one controller in
  // each document so reinjection after navigation or extension reload is safe.
  const INSTANCE = '__craigZoneContentControllerV1';
  if (window[INSTANCE]) return;

  const OVERLAY_ID = 'craig-zone-status';
  const CURSOR_HIDDEN_CLASS = 'craig-zone-cursor-hidden';
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const SAVED_STYLE = new WeakMap();
  const theaterMutations = new Set();
  let enabled = false;
  let currentState = { slot: 1, total: 0, label: '', muted: false, active: false, autoFullscreenAllowed: false };
  let overlay;
  let overlayLabel;
  let overlayLastButton;
  let hideTimer;
  let cursorHideTimer;
  let cursorHidden = false;
  let cursorClassAdded = false;
  let lastCursorPoint = null;
  let lastCursorPointInside = false;
  let windowCheckTimer;
  let fullscreenTarget = null;
  let fullscreenCandidateKind = null;
  let rememberedAutoVideo = null;
  let selectedAutoVideo = null;
  let autoAwaitingPlay = false;
  let autoSelectionTimer = null;
  let autoAttemptTimer = null;
  let autoAttemptPending = false;
  let nativeRepeatExitPending = false;
  let theaterTarget = null;
  let theaterCandidateKind = null;
  let theaterGeometryVideos = [];
  let theaterWrapperPath = null;
  let cursorTargets = [];
  let theaterVideos = [];
  let nativeControlsOriginal = new Map();
  const seekingVideos = new Set();
  const heldPointers = new Set();
  const geometryRepairTimers = new Set();
  let bridgeExitPending = false;
  let bridgePreparePending = false;
  let bridgeApplied = false;
  let exitOperationToken = null;
  let exitOperationPromise = null;
  const preparedOperations = new Map();
  let latestFullscreenToken = null;
  let statusNotice = '';
  let stopped = false;

  function send(message) {
    try {
      const result = browser.runtime.sendMessage(message);
      return Promise.resolve(result).catch(() => null);
    } catch (_) {
      // Extension shutdown or a restricted page can make messaging unavailable.
      return Promise.resolve(null);
    }
  }

  function stateText() {
    if (statusNotice) return statusNotice;
    const { slot, total, label } = currentState;
    const position = total > 0 ? `#${slot} · ${total} games` : `#${slot}`;
    const game = label ? `${position} · ${label}` : position;
    return currentState.muted ? `${game} · Muted` : game;
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    if (!document.documentElement) return null;
    overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.className = 'craig-zone-status';
      overlay.setAttribute('aria-live', 'polite');
      overlay.setAttribute('role', 'status');
      overlayLabel = document.createElement('span');
      overlayLabel.className = 'craig-zone-status-label';
      overlayLastButton = document.createElement('button');
      overlayLastButton.className = 'craig-zone-last-button';
      overlayLastButton.type = 'button';
      overlayLastButton.textContent = '↶';
      overlayLastButton.setAttribute('aria-label', 'Previous game');
      overlayLastButton.title = 'Previous game (B)';
      overlayLastButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        send({ type: 'CZ_KEY', action: 'last' });
        showStatus();
      });
      overlay.appendChild(overlayLabel);
      overlay.appendChild(overlayLastButton);
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function showStatus(duration = 1500) {
    if (!enabled) return;
    const node = ensureOverlay();
    if (!node) return;
    if (overlayLabel) overlayLabel.textContent = stateText();
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    clearTimeout(hideTimer);
    const shownNotice = statusNotice;
    hideTimer = setTimeout(() => {
      if (overlay) {
        overlay.style.setProperty('opacity', '0', 'important');
        overlay.style.setProperty('visibility', 'hidden', 'important');
      }
      if (statusNotice === shownNotice) statusNotice = '';
    }, duration);
  }

  function saveAndSetStyle(element, property, value) {
    if (!element) return;
    let saved = SAVED_STYLE.get(element);
    if (!saved) {
      saved = new Map();
      SAVED_STYLE.set(element, saved);
    }
    if (!saved.has(property)) {
      saved.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      });
    }
    if (element.style.getPropertyValue(property) === value &&
        element.style.getPropertyPriority(property) === 'important') return;
    element.style.setProperty(property, value, 'important');
    theaterMutations.add(element);
  }

  function restoreStyle(element) {
    const saved = element && SAVED_STYLE.get(element);
    if (!saved) return;
    for (const [property, old] of saved) {
      if (old.value) element.style.setProperty(property, old.value, old.priority);
      else element.style.removeProperty(property);
    }
    SAVED_STYLE.delete(element);
  }

  function restoreProperty(element, property) {
    const saved = element && SAVED_STYLE.get(element);
    const old = saved?.get(property);
    if (!old) return;
    if (old.value) element.style.setProperty(property, old.value, old.priority);
    else element.style.removeProperty(property);
    saved.delete(property);
    if (!saved.size) SAVED_STYLE.delete(element);
  }

  function setCursorHidden(hidden) {
    if (!theaterTarget || cursorHidden === hidden) return;
    if (hidden) {
      for (const target of cursorTargets) saveAndSetStyle(target, 'cursor', 'none');
      for (const video of theaterVideos) {
        if (video.controls === true && !nativeControlsOriginal.has(video)) {
          nativeControlsOriginal.set(video, true);
          try { video.controls = false; } catch (_) { /* Native controls may be read-only in some contexts. */ }
        }
      }
      if (theaterTarget.classList && !theaterTarget.classList.contains(CURSOR_HIDDEN_CLASS)) {
        theaterTarget.classList.add(CURSOR_HIDDEN_CLASS);
        cursorClassAdded = true;
      }
    } else {
      for (const target of cursorTargets) restoreProperty(target, 'cursor');
      for (const [video, controls] of nativeControlsOriginal) {
        try { video.controls = controls; } catch (_) { /* Preserve cleanup progress for other targets. */ }
      }
      nativeControlsOriginal.clear();
      if (cursorClassAdded) theaterTarget.classList.remove(CURSOR_HIDDEN_CLASS);
      cursorClassAdded = false;
    }
    cursorHidden = hidden;
  }

  function scheduleCursorHide() {
    clearTimeout(cursorHideTimer);
    if (!enabled || stopped || !theaterTarget || heldPointers.size || seekingVideos.size) return;
    cursorHideTimer = setTimeout(() => {
      cursorHideTimer = null;
      if (enabled && !stopped && theaterTarget) setCursorHidden(true);
    }, 2000);
  }

  function isWithinTheater(event) {
    if (!theaterTarget) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.length) return path.includes(theaterTarget);
    for (let node = event.target; node; node = node.parentElement) {
      if (node === theaterTarget) return true;
    }
    return false;
  }

  function isTextEditingPath(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event.target];
    return nodes.some(node => {
      if (!(node instanceof Element)) return false;
      if (node.localName === 'textarea' || node.isContentEditable) return true;
      if (node.localName === 'input') return TEXT_INPUT_TYPES.has(String(node.type || 'text').toLowerCase());
      return node.closest?.('[contenteditable]:not([contenteditable="false"])') != null;
    });
  }

  function onCursorActivity(event, source) {
    if (!enabled || stopped || !theaterTarget || !event.isTrusted) return;
    const inside = isWithinTheater(event);
    if (source === 'mousemove') {
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      const samePoint = lastCursorPoint?.x === x && lastCursorPoint?.y === y && lastCursorPointInside === inside;
      lastCursorPoint = { x, y };
      lastCursorPointInside = inside;
      // Layout-driven mousemove events at a stationary pointer must not keep
      // resetting the idle timer or reveal a cursor that has already hidden.
      if (samePoint) return;
    }
    if (!inside) return;
    setCursorHidden(false);
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
    // Keep the cursor visible while the user is editing a field inside the
    // player surface; movement back over the player starts the idle timer.
    if (!isTextEditingPath(event)) scheduleCursorHide();
  }

  function classifyFullscreenElement(element) {
    if (!element) return 'other';
    if (element instanceof HTMLVideoElement || element.localName === 'video') return 'video';
    if (element.localName === 'iframe') return 'iframe';
    if (element.querySelector?.('video') || element.shadowRoot?.querySelector?.('video')) return 'container-video';
    return 'other';
  }

  function normalizedUrl(value, base) {
    try {
      const parsed = new URL(value, base);
      parsed.hash = '';
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function findChildFrame(childUrl) {
    const expected = normalizedUrl(childUrl, document.baseURI);
    if (!expected) return { target: null, reason: 'invalid-child-url' };
    const matches = [...document.querySelectorAll('iframe')].filter(frame => {
      const rawSrc = frame.getAttribute('src') || 'about:blank';
      return normalizedUrl(rawSrc, document.baseURI) === expected;
    });
    if (matches.length !== 1) return { target: null, reason: matches.length ? 'ambiguous-child-frame' : 'child-frame-not-found' };
    return { target: matches[0], reason: '' };
  }

  function prepareFullscreen(message) {
    if (!enabled || !message.token || !['candidate', 'ancestor'].includes(message.role)) {
      return { ready: false, reason: 'pilot-or-message-inactive' };
    }
    let target;
    if (message.role === 'candidate') {
      if (message.automatic === true) {
        target = selectedAutoVideo;
        if (!currentState.active || !currentState.autoFullscreenAllowed || !autoAttemptPending ||
            !target || target.isConnected === false || target.paused !== false || target.ended ||
            !(target instanceof HTMLVideoElement) || message.candidateKind !== 'video') {
          return { ready: false, reason: 'automatic-video-target-unavailable' };
        }
      } else {
        target = fullscreenTarget;
        if (!target || target.isConnected === false || classifyFullscreenElement(target) !== message.candidateKind) {
          return { ready: false, reason: 'fullscreen-target-unavailable' };
        }
        if (!document.fullscreenElement && !bridgeApplied) return { ready: false, reason: 'native-fullscreen-ended' };
      }
    } else {
      const match = findChildFrame(message.childUrl);
      if (!match.target) return { ready: false, reason: match.reason };
      target = match.target;
    }
    preparedOperations.set(message.token, {
      token: message.token,
      role: message.role,
      candidateKind: message.candidateKind,
      target,
      automatic: message.automatic === true
    });
    latestFullscreenToken = message.token;
    bridgePreparePending = true;
    return { ready: true };
  }

  function stageFullscreen(message) {
    const preparedOperation = preparedOperations.get(message.token);
    if (!preparedOperation) return { ok: false, reason: 'fullscreen-operation-not-prepared' };
    if (preparedOperation.role !== message.role) return { ok: false, reason: 'fullscreen-operation-role-mismatch' };
    if (!bridgePreparePending) return { ok: false, reason: 'fullscreen-operation-not-pending' };
    if (preparedOperation.staged) return { ok: true };
    const target = preparedOperation.target;
    if (!target || target.isConnected === false) return { ok: false, reason: 'theater-target-unavailable' };
    try {
      applyTheaterTarget(target, preparedOperation.candidateKind);
      preparedOperation.staged = true;
      return { ok: true };
    } catch (_) {
      restoreTheater();
      return { ok: false, reason: 'theater-style-failed' };
    }
  }

  function nextFrame() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  async function exitFullscreenForBridge(message) {
    const preparedOperation = preparedOperations.get(message.token);
    if (!preparedOperation || !bridgePreparePending) {
      return { ok: false, reason: 'fullscreen-operation-not-prepared' };
    }
    if (!preparedOperation.staged) return { ok: false, reason: 'theater-target-not-staged' };
    if (exitOperationToken === message.token && exitOperationPromise) return exitOperationPromise;
    if (!document.fullscreenElement) return { ok: false, reason: 'native-fullscreen-ended' };
    bridgeExitPending = true;
    exitOperationToken = message.token;
    try {
      exitOperationPromise = Promise.resolve(document.exitFullscreen?.()).then(async () => {
        // The top document's promise can settle before its nested child
        // documents update fullscreenElement. Styles are already staged, so
        // wait one frame for the full iframe chain to leave native fullscreen.
        await nextFrame();
        if (document.fullscreenElement) return { ok: false, reason: 'native-fullscreen-still-active' };
        return { ok: true };
      });
      return await exitOperationPromise;
    } catch (_) {
      bridgeExitPending = false;
      return { ok: false, reason: 'native-exit-failed' };
    }
  }

  async function exitNativeFullscreenForRestore() {
    if (window !== window.top) return { ok: false, reason: 'top-frame-required' };
    if (!document.fullscreenElement) return { ok: true };
    try {
      await Promise.resolve(document.exitFullscreen?.());
      await nextFrame();
      return document.fullscreenElement ? { ok: false, reason: 'native-fullscreen-still-active' } : { ok: true };
    } catch (_) {
      return { ok: false, reason: 'native-exit-failed' };
    }
  }

  function applyFullscreen(message) {
    const preparedOperation = preparedOperations.get(message.token);
    if (!preparedOperation || preparedOperation.role !== message.role || !bridgePreparePending) {
      return { ok: false, reason: 'fullscreen-operation-not-prepared' };
    }
    const target = preparedOperation.target;
    if (!target || target.isConnected === false) return { ok: false, reason: 'theater-target-unavailable' };
    if (!preparedOperation.staged) return { ok: false, reason: 'theater-target-not-staged' };
    if (document.fullscreenElement) return { ok: false, reason: 'native-fullscreen-still-active' };
    bridgeApplied = true;
    bridgePreparePending = false;
    bridgeExitPending = false;
    if (preparedOperation.automatic) {
      autoAttemptPending = false;
      clearTimeout(autoAttemptTimer);
      autoAttemptTimer = null;
      selectedAutoVideo = target;
      rememberedAutoVideo = target;
    } else if (preparedOperation.role === 'candidate') {
      const videos = target instanceof HTMLVideoElement || target.localName === 'video'
        ? [target] : collectVideos(target);
      rememberedAutoVideo = videos.length === 1 ? videos[0] : null;
    }
    scheduleTheaterGeometryRepair();
    return { ok: true };
  }

  function abortFullscreen(message) {
    if (message.token && !preparedOperations.has(message.token)) return { ok: false };
    restoreTheater();
    fullscreenTarget = null;
    fullscreenCandidateKind = null;
    preparedOperations.clear();
    latestFullscreenToken = null;
    bridgePreparePending = false;
    bridgeExitPending = false;
    bridgeApplied = false;
    autoAttemptPending = false;
    autoAwaitingPlay = false;
    nativeRepeatExitPending = false;
    clearTimeout(autoAttemptTimer);
    autoAttemptTimer = null;
    exitOperationToken = null;
    exitOperationPromise = null;
    if (message.warning) {
      statusNotice = String(message.warning).slice(0, 150);
      showStatus();
    }
    return { ok: true };
  }

  function applyTheaterTarget(target, candidateKind) {
    if (theaterTarget && theaterTarget !== target) restoreTheater();
    theaterTarget = target;
    theaterCandidateKind = candidateKind;
    lastCursorPoint = null;
    lastCursorPointInside = false;
    const rootIsVideo = target instanceof HTMLVideoElement || target.localName === 'video';
    const videos = collectVideos(target).filter(video => video !== target);
    // Keep broad target transforms reversible, but size descendant media only
    // when the manually selected surface contains one unambiguous video.
    theaterGeometryVideos = videos.length === 1 ? videos.slice() : [];
    theaterWrapperPath = theaterGeometryVideos.length === 1 ? wrappersBetween(target, theaterGeometryVideos[0]) : null;
    applyTargetGeometry(target, candidateKind, theaterGeometryVideos, theaterWrapperPath);
    cursorTargets = [...new Set([target, ...videos])];
    theaterVideos = [...new Set([...(rootIsVideo ? [target] : []), ...videos])];
    for (const video of theaterVideos) {
      video.addEventListener('seeking', onVideoSeeking, true);
      video.addEventListener('seeked', onVideoSeeked, true);
    }
    cursorHidden = false;
    scheduleCursorHide();
  }

  function applyTargetGeometry(target, candidateKind, videos, wrapperPath) {
    saveAndSetStyle(target, 'position', 'fixed');
    saveAndSetStyle(target, 'inset', '0');
    saveAndSetStyle(target, 'width', '100vw');
    saveAndSetStyle(target, 'height', '100vh');
    saveAndSetStyle(target, 'max-width', 'none');
    saveAndSetStyle(target, 'max-height', 'none');
    saveAndSetStyle(target, 'margin', '0');
    saveAndSetStyle(target, 'box-sizing', 'border-box');
    saveAndSetStyle(target, 'transition', 'none');
    saveAndSetStyle(target, 'z-index', '2147483646');
    const rootIsVideo = target instanceof HTMLVideoElement || target.localName === 'video';
    // A fullscreen <video> is the viewport-sized theater target itself. Do not
    // apply the descendant 100% rule to it: that would replace its 100vw/vh
    // dimensions and can leave it anchored at the page's top-left.
    if (rootIsVideo) {
      saveAndSetStyle(target, 'object-fit', 'contain');
      saveAndSetStyle(target, 'background', '#000');
    }
    for (const video of videos) {
      saveAndSetStyle(video, 'width', '100%');
      saveAndSetStyle(video, 'height', '100%');
      saveAndSetStyle(video, 'max-width', 'none');
      saveAndSetStyle(video, 'max-height', 'none');
      saveAndSetStyle(video, 'object-fit', 'contain');
      saveAndSetStyle(video, 'background', '#000');
    }
    // Some embeds put the video inside a fixed-size surface (often the small
    // preview dimensions). Expand only the unique path to the exact selected
    // video; never reveal sibling/ad surfaces or guess a player wrapper.
    if (videos.length === 1 && wrapperPath && videos[0].isConnected !== false &&
        sameNodePath(wrappersBetween(target, videos[0]), wrapperPath)) {
      for (const wrapper of wrapperPath) {
        for (const [property, value] of [
          ['width', '100%'], ['height', '100%'], ['min-width', '0'], ['min-height', '0'],
          ['max-width', 'none'], ['max-height', 'none'], ['margin', '0'], ['box-sizing', 'border-box'],
          ['padding', '0'], ['border-width', '0'], ['transition', 'none']
        ]) saveAndSetStyle(wrapper, property, value);
      }
    }
    if (candidateKind === 'iframe' || target.localName === 'iframe') {
      saveAndSetStyle(target, 'display', 'block');
      saveAndSetStyle(target, 'border', '0');
      saveAndSetStyle(target, 'padding', '0');
    }
    if (typeof getComputedStyle === 'function') {
      for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) {
        let computed;
        try { computed = getComputedStyle(ancestor); } catch (_) { continue; }
        // These CSS features can make a fixed descendant use an ancestor as
        // its containing block. Neutralize only active triggers, and restore
        // each original inline value when theater mode ends.
        for (const property of ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter']) {
          const value = computed.getPropertyValue?.(property) || computed[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
          if (value && value !== 'none') saveAndSetStyle(ancestor, property, 'none');
        }
        const contain = computed.contain || computed.getPropertyValue?.('contain');
        if (contain && contain !== 'none' && /layout|paint|strict|content/.test(contain)) {
          saveAndSetStyle(ancestor, 'contain', 'none');
        }
        const willChange = computed.willChange || computed.getPropertyValue?.('will-change');
        if (willChange && willChange !== 'auto' && /transform|perspective|filter|contain/.test(willChange)) {
          saveAndSetStyle(ancestor, 'will-change', 'auto');
        }
        const containerType = computed.containerType || computed.getPropertyValue?.('container-type');
        if (containerType && containerType !== 'normal') saveAndSetStyle(ancestor, 'container-type', 'normal');
        const contentVisibility = computed.contentVisibility || computed.getPropertyValue?.('content-visibility');
        if (contentVisibility && contentVisibility !== 'visible') saveAndSetStyle(ancestor, 'content-visibility', 'visible');
        if (ancestor === target || ancestor === document.documentElement || ancestor === document.body) continue;
        if ((computed.overflowX && computed.overflowX !== 'visible') ||
            (computed.overflowY && computed.overflowY !== 'visible')) {
          saveAndSetStyle(ancestor, 'overflow', 'visible');
        }
      }
    }
    // Every staged document (including each verified iframe ancestor) must
    // suppress its own viewport scrolling. Tall page content and forced root
    // overflow otherwise leave a scrollbar beside the expanded player.
    for (const root of [document.documentElement, document.body]) {
      if (!root) continue;
      saveAndSetStyle(root, 'overflow-x', 'hidden');
      saveAndSetStyle(root, 'overflow-y', 'hidden');
      saveAndSetStyle(root, 'scrollbar-gutter', 'auto');
      saveAndSetStyle(root, 'overscroll-behavior', 'none');
    }
    return videos;
  }

  function wrappersBetween(target, video) {
    const path = [];
    let node = video;
    while (node && node !== target) {
      const root = node.getRootNode?.();
      const parent = node.parentElement || root?.host || null;
      if (!parent) return null;
      if (parent !== target) path.unshift(parent);
      node = parent;
    }
    return node === target ? path : null;
  }

  function sameNodePath(current, expected) {
    return Array.isArray(current) && current.length === expected.length &&
      current.every((node, index) => node === expected[index]);
  }

  function reconcileTheaterGeometry() {
    if (!bridgeApplied || !theaterTarget || theaterTarget.isConnected === false || stopped) return;
    const connectedVideos = theaterGeometryVideos.filter(video => video.isConnected !== false);
    const wrapperPath = theaterGeometryVideos.length === 1 && connectedVideos.length === 1 &&
      sameNodePath(wrappersBetween(theaterTarget, connectedVideos[0]), theaterWrapperPath || [])
      ? theaterWrapperPath : null;
    applyTargetGeometry(theaterTarget, theaterCandidateKind, connectedVideos, wrapperPath);
  }

  function scheduleTheaterGeometryRepair() {
    for (const timer of geometryRepairTimers) clearTimeout(timer);
    geometryRepairTimers.clear();
    for (const delay of [0, 180, 500]) {
      const timer = setTimeout(() => {
        geometryRepairTimers.delete(timer);
        if (!bridgeApplied || !theaterTarget || stopped) return;
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reconcileTheaterGeometry);
        else reconcileTheaterGeometry();
      }, delay);
      geometryRepairTimers.add(timer);
    }
  }

  function collectVideos(root) {
    const videos = new Set();
    const visited = new Set();
    const visit = node => {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node instanceof HTMLVideoElement || node.localName === 'video') videos.add(node);
      for (const video of node.querySelectorAll?.('video') || []) videos.add(video);
      // Open shadow roots are part of the same player surface and need inline
      // sizing because document CSS cannot reach their video descendants.
      for (const element of node.querySelectorAll?.('*') || []) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
      if (node.shadowRoot) visit(node.shadowRoot);
    };
    visit(root);
    return [...videos];
  }

  function restoreTheater() {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
    for (const timer of geometryRepairTimers) clearTimeout(timer);
    geometryRepairTimers.clear();
    if (cursorHidden && theaterTarget) setCursorHidden(false);
    cursorHidden = false;
    cursorClassAdded = false;
    for (const video of theaterVideos) {
      video.removeEventListener('seeking', onVideoSeeking, true);
      video.removeEventListener('seeked', onVideoSeeked, true);
    }
    theaterVideos = [];
    seekingVideos.clear();
    heldPointers.clear();
    lastCursorPoint = null;
    lastCursorPointInside = false;
    for (const element of theaterMutations) restoreStyle(element);
    theaterMutations.clear();
    theaterTarget = null;
    theaterCandidateKind = null;
    theaterGeometryVideos = [];
    theaterWrapperPath = null;
    cursorTargets = [];
  }

  function onFullscreenChange() {
    if (stopped) return;
    const element = document.fullscreenElement;
    if (element && enabled) {
      if (bridgeApplied && theaterTarget && latestFullscreenToken && !nativeRepeatExitPending) {
        // Re-entering native player fullscreen while theater is active is the
        // user's request to leave theater mode and opt out of future auto mode.
        // Each nested document observes fullscreenchange, but frame 0 owns the
        // single exit and asks the background to coordinate restoration.
        if (window !== window.top) return;
        nativeRepeatExitPending = true;
        const token = latestFullscreenToken;
        send({ type: 'CZ_FS_RESTORE_REQUEST', token, optOut: true, nativeExit: true });
        return;
      }
      // Keep the local element reference until the background coordinates the
      // whole iframe chain and exits native fullscreen exactly once.
      fullscreenTarget = element;
      fullscreenCandidateKind = classifyFullscreenElement(element);
      send({ type: 'CZ_FS_CANDIDATE', kind: fullscreenCandidateKind });
      return;
    }
    // Covers Escape or player-native exit from page fullscreen.
    if (!element && fullscreenTarget) {
      if (bridgePreparePending || bridgeExitPending || bridgeApplied) {
        return;
      }
      fullscreenTarget = null;
      fullscreenCandidateKind = null;
      restoreTheater();
    }
  }

  function isEditablePath(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event.target, document.activeElement];
    return nodes.some(node => {
      if (!(node instanceof Element)) return false;
      const tag = node.localName;
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable) return true;
      return node.closest?.('[contenteditable]:not([contenteditable="false"])') !== null;
    });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && theaterTarget) {
      // Let Firefox consume Escape to leave its browser fullscreen mode.
      send({ type: 'CZ_FS_RESTORE_REQUEST', token: latestFullscreenToken, optOut: true });
      selectedAutoVideo = null;
      autoAttemptPending = false;
      autoAwaitingPlay = false;
      clearTimeout(autoSelectionTimer);
      clearTimeout(autoAttemptTimer);
      autoSelectionTimer = null;
      autoAttemptTimer = null;
      fullscreenTarget = null;
      restoreTheater();
      bridgePreparePending = false;
      bridgeExitPending = false;
      bridgeApplied = false;
      return;
    }
    if (!enabled || stopped || event.defaultPrevented || event.repeat ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditablePath(event)) return;

    let message;
    if (event.key === 'ArrowRight') message = { type: 'CZ_KEY', action: 'next' };
    else if (event.key === 'ArrowLeft') message = { type: 'CZ_KEY', action: 'previous' };
    else if (event.key === 'b' || event.key === 'B') message = { type: 'CZ_KEY', action: 'last' };
    else if (event.key === 'm' || event.key === 'M') message = { type: 'CZ_KEY', action: 'mute' };
    else if (/^[1-9]$/.test(event.key)) {
      const slot = Number(event.key);
      message = { type: 'CZ_KEY', action: 'slot', slot };
    }
    if (!message) return;

    event.preventDefault();
    event.stopPropagation();
    send(message);
    showStatus();
  }

  function onMouseMove(event) {
    onCursorActivity(event, 'mousemove');
    if (!enabled || !event.isTrusted || event.clientX < innerWidth - 68 || event.clientY > 68) return;
    const node = ensureOverlay();
    if (!node) return;
    if (overlayLabel) overlayLabel.textContent = stateText();
    node.style.setProperty('pointer-events', 'none', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    clearTimeout(hideTimer);
    const shownNotice = statusNotice;
    hideTimer = setTimeout(() => {
      if (!overlay) return;
      overlay.style.setProperty('opacity', '0', 'important');
      overlay.style.setProperty('visibility', 'hidden', 'important');
      if (statusNotice === shownNotice) statusNotice = '';
    }, 1500);
  }

  function onPointerDown(event) {
    onCursorActivity(event, 'pointerdown');
    if (event.isTrusted && isWithinTheater(event)) {
      heldPointers.add(Number.isInteger(event.pointerId) ? event.pointerId : -1);
      clearTimeout(cursorHideTimer);
      cursorHideTimer = null;
    }
    armAutomaticVideo(event);
  }

  function onPointerEnd(event) {
    if (!event.isTrusted) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : -1;
    if (!heldPointers.delete(pointerId) || heldPointers.size || seekingVideos.size || !theaterTarget) return;
    setCursorHidden(false);
    if (!isTextEditingPath(event)) scheduleCursorHide();
  }

  function onVideoSeeking(event) {
    if (!theaterVideos.includes(event.target)) return;
    seekingVideos.add(event.target);
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
    setCursorHidden(false);
  }

  function onVideoSeeked(event) {
    if (!seekingVideos.delete(event.target)) return;
    if (!seekingVideos.size && !heldPointers.size) scheduleCursorHide();
  }

  function onTheaterKeyActivity(event) {
    if (!event.isTrusted || !theaterTarget || isTextEditingPath(event)) return;
    setCursorHidden(false);
    scheduleCursorHide();
  }

  function onWindowBlur() {
    heldPointers.clear();
    if (theaterTarget && !seekingVideos.size) scheduleCursorHide();
  }

  function isVisibleSubstantialVideo(video) {
    if (!(video instanceof HTMLVideoElement) || video.isConnected === false ||
        typeof video.getBoundingClientRect !== 'function') return false;
    const rect = video.getBoundingClientRect();
    if (!rect || rect.width < 320 || rect.height < 180) return false;
    const visibleWidth = Math.min(innerWidth, rect.right) - Math.max(0, rect.left);
    const visibleHeight = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top);
    if (visibleWidth < 320 || visibleHeight < 180) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(video);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  }

  function directVideoFromEvent(event) {
    if (!event.isTrusted) return null;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] || event.target;
    if (target !== event.target || !(target instanceof HTMLVideoElement) || !isVisibleSubstantialVideo(target)) return null;
    return target;
  }

  function playControlVideoFromEvent(event) {
    if (!event.isTrusted) return null;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const control = path.find(node => node instanceof Element &&
      (node.localName === 'button' || node.getAttribute?.('role') === 'button') &&
      /\b(play|start|watch)\b/i.test([node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.textContent].filter(Boolean).join(' ')));
    if (!control) return null;
    // A deliberate Play control is associated only with one visible video in
    // its bounded player container. Ambiguous and page-wide targets stay manual.
    let container = control.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      if (container === document.body || container === document.documentElement) break;
      const videos = collectVideos(container).filter(isVisibleSubstantialVideo);
      if (videos.length > 1) return null;
      if (videos.length === 1) return videos[0];
    }
    return null;
  }

  function armAutomaticVideo(event) {
    const video = directVideoFromEvent(event) || playControlVideoFromEvent(event);
    if (selectedAutoVideo === video && autoAwaitingPlay) return;
    if (!video || !enabled || !currentState.active || !currentState.autoFullscreenAllowed ||
        theaterTarget || bridgePreparePending || bridgeApplied) return;
    if (video.paused !== true) {
      selectedAutoVideo = null;
      autoAwaitingPlay = false;
      clearTimeout(autoSelectionTimer);
      autoSelectionTimer = null;
      return;
    }
    selectedAutoVideo = video;
    autoAwaitingPlay = true;
    clearTimeout(autoSelectionTimer);
    autoSelectionTimer = setTimeout(() => {
      autoSelectionTimer = null;
      if (!autoAttemptPending) selectedAutoVideo = null;
    }, 5000);
  }

  function tryAutomaticTheater(video) {
    requestAutomaticTheater(video, false);
  }

  function requestAutomaticTheater(video, manuallyConfirmed) {
    if (!video || video !== selectedAutoVideo || (!autoAwaitingPlay && !manuallyConfirmed) || !enabled || !currentState.active ||
        !currentState.autoFullscreenAllowed || autoAttemptPending || theaterTarget ||
        bridgePreparePending || bridgeApplied || video.isConnected === false ||
        video.paused !== false || video.ended || Number(video.readyState) < 2 ||
        !isVisibleSubstantialVideo(video)) return;
    autoAttemptPending = true;
    autoAwaitingPlay = false;
    clearTimeout(autoSelectionTimer);
    autoSelectionTimer = null;
    autoAttemptTimer = setTimeout(() => {
      autoAttemptPending = false;
      autoAttemptTimer = null;
      selectedAutoVideo = null;
    }, 10000);
    send({ type: 'CZ_FS_CANDIDATE', kind: 'video', automatic: true });
  }

  function onPlayerClick(event) {
    const video = directVideoFromEvent(event) || playControlVideoFromEvent(event);
    if (!video) return;
    armAutomaticVideo(event);
  }

  function onVideoPlaying(event) {
    const video = event.target;
    if (!isVisibleSubstantialVideo(video)) return;
    if (video === selectedAutoVideo && autoAwaitingPlay) tryAutomaticTheater(video);
    else if (video === rememberedAutoVideo && currentState.active && currentState.autoFullscreenAllowed) {
      selectedAutoVideo = video;
      requestAutomaticTheater(video, true);
    }
  }

  function requestRememberedVideoOnReturn(previousState) {
    if ((!previousState.active || !previousState.autoFullscreenAllowed) &&
        currentState.active && currentState.autoFullscreenAllowed && rememberedAutoVideo &&
        !theaterTarget && !bridgeApplied && !document.fullscreenElement) {
      selectedAutoVideo = rememberedAutoVideo;
      requestAutomaticTheater(rememberedAutoVideo, true);
    }
  }

  function onResize() {
    if (!enabled || stopped) return;
    reconcileTheaterGeometry();
    clearTimeout(windowCheckTimer);
    windowCheckTimer = setTimeout(() => {
      windowCheckTimer = null;
      if (enabled && !stopped) send({ type: 'CZ_FS_CHECK_WINDOW' });
    }, 100);
  }

  function cleanup() {
    stopped = true;
    enabled = false;
    fullscreenTarget = null;
    fullscreenCandidateKind = null;
    selectedAutoVideo = null;
    autoAwaitingPlay = false;
    clearTimeout(autoSelectionTimer);
    clearTimeout(autoAttemptTimer);
    autoSelectionTimer = null;
    autoAttemptTimer = null;
    autoAttemptPending = false;
    nativeRepeatExitPending = false;
    preparedOperations.clear();
    latestFullscreenToken = null;
    bridgeExitPending = false;
    bridgePreparePending = false;
    bridgeApplied = false;
    exitOperationToken = null;
    exitOperationPromise = null;
    clearTimeout(hideTimer);
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
    clearTimeout(windowCheckTimer);
    windowCheckTimer = null;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keydown', onTheaterKeyActivity, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerEnd, true);
    document.removeEventListener('pointercancel', onPointerEnd, true);
    document.removeEventListener('click', onPlayerClick, true);
    document.removeEventListener('playing', onVideoPlaying, true);
    window.removeEventListener('resize', onResize, true);
    window.removeEventListener('blur', onWindowBlur, true);
    restoreTheater();
    document.getElementById(OVERLAY_ID)?.remove();
    overlay = null;
    window.removeEventListener('pagehide', onPageHide, true);
    window.removeEventListener('pageshow', onPageShow, true);
    browser.runtime.onMessage.removeListener(onMessage);
    delete window[INSTANCE];
  }

  function onPageHide(event) {
    if (!event.persisted) cleanup();
  }

  function onPageShow(event) {
    if (event.persisted) send({ type: 'CZ_STATE' }).then(onMessage);
  }

  function onMessage(message) {
    if (stopped || !message || typeof message !== 'object') return;
    if (message.type === 'CZ_READY_PLAYER') {
      statusNotice = 'Click Play to watch. CraigZone expands a recognized player after playback begins.';
      showStatus(5000);
      return Promise.resolve({ ok: true });
    }
    // Firefox sends a tabs.sendMessage response only when the listener returns
    // a Promise (or calls sendResponse). Keep the ACK protocol explicit here.
    if (message.type === 'CZ_FS_PREPARE') return Promise.resolve(prepareFullscreen(message));
    if (message.type === 'CZ_FS_STAGE') return Promise.resolve(stageFullscreen(message));
    if (message.type === 'CZ_FS_EXIT') return exitFullscreenForBridge(message);
    if (message.type === 'CZ_FS_NATIVE_EXIT') return exitNativeFullscreenForRestore();
    if (message.type === 'CZ_FS_APPLY') return Promise.resolve(applyFullscreen(message));
    if (message.type === 'CZ_FS_ABORT') return Promise.resolve(abortFullscreen(message));
    if (message.type === 'CZ_FS_WARNING') {
      statusNotice = typeof message.warning === 'string' ? message.warning.slice(0, 150) : 'Embedded player fullscreen is unavailable.';
      showStatus();
      return Promise.resolve({ ok: true });
    }
    if (message.type === 'CZ_FS_RESTORE') return Promise.resolve(abortFullscreen(message));
    if (message.type === 'CZ_STATE') {
      const wasEnabled = enabled;
      const previousState = currentState;
      enabled = message.enabled === true;
      currentState = {
        slot: Number.isInteger(message.slot) && message.slot > 0 ? message.slot : 1,
        total: Number.isInteger(message.total) && message.total >= 0 ? message.total : 0,
        label: typeof message.label === 'string' ? message.label.slice(0, 120) : '',
        muted: message.muted === true,
        active: message.active === true,
        autoFullscreenAllowed: message.autoFullscreenAllowed === true
      };
      if (enabled) {
        requestRememberedVideoOnReturn(previousState);
        if (!wasEnabled || currentState.slot !== previousState.slot ||
            currentState.total !== previousState.total || currentState.label !== previousState.label ||
            currentState.muted !== previousState.muted) showStatus();
      } else {
        selectedAutoVideo = null;
        autoAttemptPending = false;
        autoAwaitingPlay = false;
        clearTimeout(autoSelectionTimer);
        clearTimeout(autoAttemptTimer);
        autoSelectionTimer = null;
        autoAttemptTimer = null;
        fullscreenTarget = null;
        fullscreenCandidateKind = null;
        preparedOperations.clear();
        latestFullscreenToken = null;
        bridgeExitPending = false;
        bridgePreparePending = false;
        bridgeApplied = false;
        exitOperationToken = null;
        exitOperationPromise = null;
        restoreTheater();
        if (overlay) {
          overlay.style.setProperty('opacity', '0', 'important');
          overlay.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    } else if (message.type === 'CZ_STOP') {
      cleanup();
    }
  }

  window[INSTANCE] = { cleanup };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keydown', onTheaterKeyActivity, true);
  document.addEventListener('fullscreenchange', onFullscreenChange, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  document.addEventListener('click', onPlayerClick, true);
  document.addEventListener('playing', onVideoPlaying, true);
  window.addEventListener('resize', onResize, true);
  window.addEventListener('blur', onWindowBlur, true);
  window.addEventListener('pagehide', onPageHide, true);
  window.addEventListener('pageshow', onPageShow, true);
  browser.runtime.onMessage.addListener(onMessage);
  send({ type: 'CZ_STATE' }).then(onMessage);
})();
