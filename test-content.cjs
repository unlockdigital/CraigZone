'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'extension/content.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'extension/content.css'), 'utf8');

class FakeStyle {
  constructor() { this.values = new Map(); this.writeCount = 0; }
  setProperty(k, v, p = '') { this.writeCount += 1; this.values.set(k, [String(v), p]); }
  getPropertyValue(k) { return this.values.get(k)?.[0] || ''; }
  getPropertyPriority(k) { return this.values.get(k)?.[1] || ''; }
  removeProperty(k) { this.values.delete(k); }
}
class FakeElement {
  constructor(name = 'div') {
    this.localName = name;
    this.style = new FakeStyle();
    this.isContentEditable = false;
    this.isConnected = true;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    };
    this.src = '';
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(listener => listener !== fn); }
  dispatch(type, event = {}) { (this.listeners[type] || []).slice().forEach(fn => fn(event)); }
  remove() { this.isConnected = false; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? (k === 'src' ? this.src : null); }
  appendChild(node) { this.children.push(node); node.parentNode = this; node.parentElement = this; return node; }
  querySelector() { return null; }
  querySelectorAll() { return this.descendants || []; }
  closest(selector) { return selector.includes('contenteditable') && this.contentEditable ? this : null; }
}
class FakeVideo extends FakeElement {
  constructor() {
    super('video');
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.controls = false;
    this.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 });
  }
}

const listeners = {};
const windowListeners = {};
const messages = [];
const root = new FakeElement('html');
const body = new FakeElement('body');
root.style.setProperty('overflow-y', 'scroll', 'important');
root.style.setProperty('scrollbar-gutter', 'stable');
body.style.setProperty('overflow-x', 'auto');
let resolveExit;
let resolveFrame;
let exitCalls = 0;
let frames = [];
let nextTimerId = 0;
const pendingTimers = new Map();
let stateResponse = { type: 'CZ_STATE', enabled: true, slot: 1, total: 4, label: 'Initial game' };
const document = {
  documentElement: root,
  body,
  activeElement: null,
  fullscreenElement: null,
  baseURI: 'https://outer.example/page',
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(x => x !== fn); },
  getElementById(id) { return root.children.find(n => n.id === id && n.isConnected) || null; },
  querySelectorAll(selector) { return selector === 'iframe' ? frames : []; },
  createElement(name) { return new FakeElement(name); },
  exitFullscreen() {
    exitCalls += 1;
    this.fullscreenElement = null;
    listeners.fullscreenchange.at(-1)();
    return new Promise(resolve => { resolveExit = resolve; });
  }
};
const runtimeListeners = [];
const browser = {
  runtime: {
    sendMessage(message) { messages.push(message); return Promise.resolve(message.type === 'CZ_STATE' ? stateResponse : { ok: true }); },
    onMessage: { addListener(fn) { runtimeListeners.push(fn); }, removeListener(fn) { const i = runtimeListeners.indexOf(fn); if (i >= 0) runtimeListeners.splice(i, 1); } }
  }
};
const window = {
  innerWidth: 1280, innerHeight: 720,
  addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { windowListeners[type] = (windowListeners[type] || []).filter(x => x !== fn); }
};
window.top = window;
const context = {
  window, document, browser, Element: FakeElement, HTMLVideoElement: FakeVideo,
  HTMLIFrameElement: class extends FakeElement { constructor() { super('iframe'); } },
  HTMLObjectElement: class extends FakeElement { constructor() { super('object'); } },
  HTMLEmbedElement: class extends FakeElement { constructor() { super('embed'); } },
  getComputedStyle(element) {
    return {
      transform: 'none', translate: 'none', rotate: 'none', scale: 'none',
      perspective: 'none', filter: 'none', backdropFilter: 'none',
      contain: 'none', willChange: 'auto', containerType: 'normal',
      contentVisibility: 'visible', overflowX: 'visible', overflowY: 'visible',
      ...element.computedStyle
    };
  },
  Map, WeakMap, Number, String, URL, Promise,
  setTimeout(callback, delay) { const id = ++nextTimerId; pendingTimers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
  requestAnimationFrame(callback) { resolveFrame = callback; return 1; },
  innerWidth: 1280, innerHeight: 720, console
};
(async () => {
vm.runInNewContext(source, context);

assert.equal(JSON.stringify(messages[0]), JSON.stringify({ type: 'CZ_STATE' }), 'requests initial state');
await Promise.resolve();
await Promise.resolve();
assert.equal(runtimeListeners.length, 1, 'initial response leaves the controller active');
vm.runInNewContext(source, context);
assert.equal(runtimeListeners.length, 1, 'reinjection is idempotent per document');
assert.equal(messages.filter(m => m.type === 'CZ_STATE').length, 1, 'reinjection sends no duplicate state request');
const deliver = message => runtimeListeners.slice().forEach(fn => fn(message));
const callMessage = message => runtimeListeners[0](message);
const fireKey = (key, extras = {}) => {
  const event = {
    key, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    defaultPrevented: false, target: new FakeElement(), prevented: false, stopped: false,
    composedPath() { return extras.path || [this.target]; },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    ...extras
  };
  (listeners.keydown || []).slice().forEach(fn => fn(event));
  return event;
};
const fireActivity = (type, path, isTrusted = true, clientX = 100, clientY = 100) => {
  const event = { target: path[0], isTrusted, clientX, clientY, composedPath() { return path; } };
  (listeners[type] || []).slice().forEach(fn => fn(event));
  return event;
};
const firePlayerEvent = (type, target, isTrusted = true, path = [target]) => {
  const event = { target, isTrusted, composedPath() { return path; } };
  (listeners[type] || []).slice().forEach(fn => fn(event));
  return event;
};

let event = fireKey('ArrowRight');
assert.equal(event.prevented, true, 'initial CZ_STATE reply enables content immediately');
assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'CZ_KEY', action: 'next' }));
deliver({ type: 'CZ_STATE', enabled: false, slot: 0, total: 0, label: '' });
event = fireKey('ArrowRight');
assert.equal(event.prevented, false, 'disabled pilot leaves page keys alone');
windowListeners.resize.at(-1)();
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 100).length, 0, 'disabled controller does not schedule window checks');
deliver({ type: 'CZ_STATE', enabled: true, slot: 2, total: 8, label: 'Game Two' });
assert.equal(root.children[0].children.length, 2, 'status overlay contains label and Last button');
assert.match(css, /\.craig-zone-last-button/, 'injected CSS styles the Last button');
deliver({ type: 'CZ_STATE', enabled: true, slot: 2, total: 8, label: 'Game Two', muted: true });
assert.match(root.children[0].children[0].textContent, /Muted$/, 'status overlay displays muted state');
deliver({ type: 'CZ_STATE', enabled: true, slot: 2, total: 8, label: 'Game Two', muted: false });
assert.doesNotMatch(root.children[0].children[0].textContent, /Muted$/, 'status overlay clears muted state');
root.children[0].style.setProperty('opacity', '0', 'important');
root.children[0].style.setProperty('visibility', 'hidden', 'important');
deliver({ type: 'CZ_STATE', enabled: true, slot: 2, total: 8, label: 'Game Two', muted: false });
assert.equal(root.children[0].style.getPropertyValue('visibility'), 'hidden', 'unchanged state does not flash the overlay during fullscreen transitions');
windowListeners.resize.at(-1)();
const enabledResizeTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 100);
assert.ok(enabledResizeTimer, 'enabled controller schedules window checks before local theater exists');
pendingTimers.delete(enabledResizeTimer[0]);
enabledResizeTimer[1].callback();
assert.equal(messages.at(-1).type, 'CZ_FS_CHECK_WINDOW', 'enabled tab can help restore another tab’s saved fullscreen chain');
const lastButton = root.children[0].children[1];
lastButton.dispatch('click', { preventDefault() {}, stopPropagation() {} });
assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'CZ_KEY', action: 'last' }));
for (const [key, action, extra] of [
  ['ArrowRight', 'next', {}], ['ArrowLeft', 'previous', {}], ['b', 'last', {}],
  ['m', 'mute', {}], ['M', 'mute', {}], ['7', 'slot', { slot: 7 }]
]) {
  event = fireKey(key);
  assert.equal(event.prevented, true, `${key} is consumed when enabled`);
  assert.equal(event.stopped, true, `${key} stops page propagation when enabled`);
  assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'CZ_KEY', action, ...extra }));
}
for (const modifier of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
  event = fireKey('ArrowRight', modifier);
  assert.equal(event.prevented, false, 'repeated and modified keys remain available to page');
  event = fireKey('m', modifier);
  assert.equal(event.prevented, false, 'mute shortcut respects repeat and modifier guards');
}
const edit = new FakeElement('input');
event = fireKey('ArrowRight', { path: [edit] });
assert.equal(event.prevented, false, 'editable composedPath is ignored');
event = fireKey('m', { path: [edit] });
assert.equal(event.prevented, false, 'mute shortcut is ignored in editable composedPath');
event = fireKey('Escape');
assert.equal(event.prevented, false, 'Escape remains available to exit fullscreen');

const video = new FakeVideo();
video.style.setProperty('position', 'relative');
video.style.setProperty('cursor', 'pointer', 'important');
video.style.setProperty('transform', 'scale(0.8)');
video.computedStyle = { transform: 'matrix(0.8, 0, 0, 0.8, 0, 0)' };
const transformedParent = new FakeElement('div');
transformedParent.style.setProperty('transform', 'translateZ(0)');
transformedParent.style.setProperty('contain', 'layout');
transformedParent.style.setProperty('will-change', 'transform');
transformedParent.style.setProperty('content-visibility', 'auto');
transformedParent.computedStyle = {
  transform: 'matrix(1, 0, 0, 1, 0, 0)', translate: '0px', contain: 'layout',
  willChange: 'transform', contentVisibility: 'auto'
};
video.parentElement = transformedParent;
document.fullscreenElement = video;
listeners.fullscreenchange.at(-1)();
assert.equal(exitCalls, 0, 'content captures candidates without exiting native fullscreen');
assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'CZ_FS_CANDIDATE', kind: 'video' }));
const prepareAck = callMessage({ type: 'CZ_FS_PREPARE', token: 'token-1', candidateFrameId: 0, candidateKind: 'video', role: 'candidate' });
assert.equal(typeof prepareAck?.then, 'function', 'Firefox handshake response is a Promise');
assert.equal((await prepareAck).ready, true);
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'token-1', role: 'candidate' })).ok, true);
assert.equal(document.fullscreenElement, video, 'theater styles stage while native fullscreen remains active');
assert.equal(video.style.getPropertyValue('position'), 'fixed', 'staging applies theater styles before native exit');
assert.equal(video.style.getPropertyValue('width'), '100vw', 'fullscreen video retains viewport width instead of being reset to 100%');
assert.equal(video.style.getPropertyValue('height'), '100vh', 'fullscreen video retains viewport height instead of being reset to 100%');
assert.equal(video.style.getPropertyValue('object-fit'), 'contain', 'fullscreen video keeps its aspect-ratio fit');
assert.equal(root.style.getPropertyValue('overflow-y'), 'hidden', 'the document viewport cannot show a vertical scrollbar in theater mode');
assert.equal(body.style.getPropertyValue('overflow-x'), 'hidden', 'the body cannot show a horizontal scrollbar in theater mode');
assert.equal(root.style.getPropertyValue('scrollbar-gutter'), 'auto', 'theater removes a reserved scrollbar gutter');
assert.equal(video.style.getPropertyValue('transform'), 'none', 'target transform cannot offset its fixed theater geometry');
assert.equal(transformedParent.style.getPropertyValue('transform'), 'none', 'transformed containing block is neutralized');
assert.equal(transformedParent.style.getPropertyValue('contain'), 'none', 'layout containment cannot trap fixed positioning');
assert.equal(transformedParent.style.getPropertyValue('will-change'), 'auto', 'will-change containing block is neutralized');
assert.equal(transformedParent.style.getPropertyValue('content-visibility'), 'visible', 'content-visibility containment is neutralized');
const stagedStyleWrites = video.style.writeCount;
const exitPromise = callMessage({ type: 'CZ_FS_EXIT', token: 'token-1' });
assert.equal(exitCalls, 1, 'only the coordinated top-frame command exits native fullscreen');
resolveExit();
await Promise.resolve();
assert.equal(typeof resolveFrame, 'function', 'exit response waits for one frame so nested fullscreen state settles');
resolveFrame();
assert.equal((await exitPromise).ok, true, 'top-frame exit waits for the fullscreen-exit promise and frame tick');
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'token-1', role: 'candidate' })).ok, true);
assert.equal(video.style.writeCount, stagedStyleWrites, 'finalize preserves staged style snapshots without reapplying');
assert.equal(video.style.getPropertyValue('position'), 'fixed', 'native fullscreen video is stretched after exit');
assert.equal(video.style.getPropertyValue('cursor'), 'pointer', 'cursor stays visible during the idle grace period');
assert.match(css, /\.craig-zone-cursor-hidden\s*,\s*\.craig-zone-cursor-hidden \*\s*\{\s*cursor:\s*none\s*!important/s, 'cursor hiding applies to player descendants with normal cursor overrides');
let cursorTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000);
assert.ok(cursorTimer, 'theater apply schedules a two-second cursor idle timer');
pendingTimers.delete(cursorTimer[0]);
cursorTimer[1].callback();
assert.equal(video.style.getPropertyValue('cursor'), 'none', 'idle cursor hides on the theater video');
assert.equal(video.style.getPropertyPriority('cursor'), 'important', 'video inline-important cursor overrides are suppressed');
assert.equal(video.classList.contains('craig-zone-cursor-hidden'), true, 'theater class hides descendant cursor overrides');
fireActivity('mousemove', [new FakeElement('main')]);
assert.equal(video.style.getPropertyValue('cursor'), 'none', 'activity outside the theater cannot reveal the cursor');
fireActivity('pointerdown', [video]);
assert.equal(video.style.getPropertyValue('cursor'), 'pointer', 'trusted pointer activity inside theater reveals the cursor');
assert.equal(video.style.getPropertyPriority('cursor'), 'important', 'reveal restores the original cursor priority');
assert.equal(video.classList.contains('craig-zone-cursor-hidden'), false, 'cursor reveal removes the scoped class');
const resizeCount = messages.filter(m => m.type === 'CZ_FS_CHECK_WINDOW').length;
windowListeners.resize.at(-1)();
windowListeners.resize.at(-1)();
const resizeTimers = [...pendingTimers.entries()].filter(([, timer]) => timer.delay === 100);
assert.equal(resizeTimers.length, 1, 'theater resize checks debounce repeated window events');
pendingTimers.delete(resizeTimers[0][0]);
resizeTimers[0][1].callback();
assert.equal(messages.filter(m => m.type === 'CZ_FS_CHECK_WINDOW').length, resizeCount + 1, 'theater resize asks background to verify Firefox fullscreen state');
event = fireKey('Escape');
assert.equal(event.prevented, false, 'Escape remains available to leave browser fullscreen');
assert.equal(video.style.getPropertyValue('position'), 'relative', 'page style is restored on Escape/exit');
assert.equal(video.style.getPropertyValue('width'), '', 'viewport width override is restored on Escape');
assert.equal(video.style.getPropertyValue('height'), '', 'viewport height override is restored on Escape');
assert.equal(root.style.getPropertyValue('overflow-y'), 'scroll', 'Escape restores the document scroll setting');
assert.equal(root.style.getPropertyPriority('overflow-y'), 'important', 'Escape restores the original scroll priority');
assert.equal(root.style.getPropertyValue('scrollbar-gutter'), 'stable', 'Escape restores the reserved gutter');
assert.equal(body.style.getPropertyValue('overflow-x'), 'auto', 'Escape restores body scrolling');
assert.equal(video.style.getPropertyValue('transform'), 'scale(0.8)', 'target transform is restored on Escape');
assert.equal(transformedParent.style.getPropertyValue('transform'), 'translateZ(0)', 'ancestor transform is restored on Escape');
assert.equal(transformedParent.style.getPropertyValue('contain'), 'layout', 'ancestor containment is restored on Escape');
assert.equal(transformedParent.style.getPropertyValue('will-change'), 'transform', 'ancestor will-change is restored on Escape');
assert.equal(transformedParent.style.getPropertyValue('content-visibility'), 'auto', 'ancestor content visibility is restored on Escape');
assert.equal(video.style.getPropertyValue('cursor'), 'pointer', 'Escape restores the page cursor style');
assert.equal(video.style.getPropertyPriority('cursor'), 'important', 'Escape restores the original cursor priority');
assert.equal(video.classList.contains('craig-zone-cursor-hidden'), false, 'Escape removes cursor hiding from the theater target');
assert(messages.some(m => m.type === 'CZ_FS_RESTORE_REQUEST' && m.token === 'token-1'), 'Escape asks background to restore every iframe layer');

const childFrame = new FakeElement('iframe');
childFrame.src = 'https://player.example/embed?id=1#native';
frames = [childFrame];
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-2', candidateFrameId: 4, candidateKind: 'video', role: 'ancestor', childFrameId: 5, childUrl: 'https://player.example/embed?id=1#child' })).ready, true, 'ancestor maps a unique child iframe by normalized URL');
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'token-2', role: 'ancestor' })).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'token-2', role: 'ancestor' })).ok, true);
assert.equal(childFrame.style.getPropertyValue('position'), 'fixed', 'ancestor iframe fills theater viewport');
assert.equal(childFrame.style.getPropertyValue('box-sizing'), 'border-box', 'iframe viewport dimensions include its border box');
assert.equal(childFrame.style.getPropertyValue('border'), '0', 'iframe default border cannot overrun the viewport');
assert.equal(childFrame.style.getPropertyValue('padding'), '0', 'iframe padding cannot overrun the viewport');
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'token-2' })).ok, true);
assert.equal(childFrame.style.getPropertyValue('position'), '', 'restore returns iframe inline styles');
assert.equal(childFrame.style.getPropertyValue('border'), '', 'restore returns iframe border styles');
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-3', candidateFrameId: 4, candidateKind: 'video', role: 'ancestor', childFrameId: 5, childUrl: 'https://missing.example/embed' })).ready, false, 'unreachable child frame fails closed');
const duplicateFrame = new FakeElement('iframe');
duplicateFrame.src = childFrame.src;
frames.push(duplicateFrame);
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-ambiguous', candidateFrameId: 4, candidateKind: 'video', role: 'ancestor', childFrameId: 5, childUrl: 'https://player.example/embed?id=1' })).ready, false, 'ambiguous iframe mapping fails closed');

const abortVideo = new FakeVideo();
document.fullscreenElement = abortVideo;
listeners.fullscreenchange.at(-1)();
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-4', candidateFrameId: 0, candidateKind: 'video', role: 'candidate' })).ready, true);
assert.equal((await callMessage({ type: 'CZ_FS_EXIT', token: 'token-4' })).ok, false, 'native exit is blocked until theater styles are staged');
assert.equal(exitCalls, 1, 'failed pre-stage exit leaves native fullscreen untouched');
assert.equal((await callMessage({ type: 'CZ_FS_ABORT', token: 'token-4' })).ok, true);
assert.equal(document.fullscreenElement, abortVideo, 'preflight abort preserves native fullscreen');

const wrapper = new FakeElement('div');
wrapper.style.setProperty('cursor', 'crosshair');
wrapper.style.setProperty('transition', 'opacity 300ms');
const wrapperVideo = new FakeVideo();
wrapperVideo.style.setProperty('cursor', 'pointer', 'important');
wrapperVideo.controls = true;
const shadowVideo = new FakeVideo();
const shadowHost = new FakeElement('player-surface');
shadowHost.shadowRoot = {
  querySelectorAll(selector) { return selector === 'video' ? [shadowVideo] : []; }
};
wrapper.querySelector = () => wrapperVideo;
wrapper.querySelectorAll = selector => selector === 'video' ? [wrapperVideo] : [shadowHost];
document.fullscreenElement = wrapper;
listeners.fullscreenchange.at(-1)();
assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'CZ_FS_CANDIDATE', kind: 'container-video' }));
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-wrapper', candidateFrameId: 0, candidateKind: 'container-video', role: 'candidate' })).ready, true);
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'token-wrapper', role: 'candidate' })).ok, true);
assert.equal(wrapper.style.getPropertyValue('position'), 'fixed', 'player wrapper is staged before fullscreen exit');
document.fullscreenElement = null;
listeners.fullscreenchange.at(-1)();
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'token-wrapper', role: 'candidate' })).ok, true);
assert.equal(wrapper.style.getPropertyValue('position'), 'fixed', 'player wrapper becomes the theater container');
assert.equal(wrapper.style.getPropertyValue('transition'), 'none', 'theater target transition cannot animate the viewport handoff');
cursorTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000);
assert.ok(cursorTimer, 'nested player gets its own cursor idle timer');
pendingTimers.delete(cursorTimer[0]);
cursorTimer[1].callback();
assert.equal(wrapper.style.getPropertyValue('cursor'), 'none', 'idle cursor hides on the player wrapper');
assert.equal(wrapperVideo.style.getPropertyValue('cursor'), 'none', 'video descendant inline-important cursor is also hidden');
assert.equal(wrapperVideo.controls, false, 'native video controls hide with the idle cursor');
assert.equal(shadowVideo.controls, false, 'videos with controls originally off stay off');
const editInPlayer = new FakeElement('input');
fireActivity('pointerdown', [editInPlayer, wrapper]);
assert.equal(wrapper.style.getPropertyValue('cursor'), 'crosshair', 'editing inside player keeps cursor visible');
assert.equal(wrapperVideo.style.getPropertyValue('cursor'), 'pointer', 'editing restores video inline-important cursor');
assert.equal(wrapperVideo.controls, true, 'trusted activity restores originally enabled native controls');
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 0, 'editing does not schedule cursor re-hide');
fireActivity('pointerup', [wrapper]);
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 1, 'pointer release rearms idle hiding after a hold');
const rangeControl = new FakeElement('input');
rangeControl.type = 'range';
fireActivity('mousemove', [rangeControl, wrapper], true, 120, 120);
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 1, 'range slider activity rearms the cursor idle timer');
const sliderTimerId = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000)[0];
fireActivity('mousemove', [rangeControl, wrapper], true, 120, 120);
assert.equal([...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000)[0], sliderTimerId, 'same-coordinate layout mousemove does not postpone idle hiding');
fireActivity('mousemove', [wrapperVideo, wrapper], true, 180, 180);
const videoTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000);
assert.ok(videoTimer && videoTimer[0] !== sliderTimerId, 'moving from the slider back to video resets the idle timer');
pendingTimers.delete(videoTimer[0]);
videoTimer[1].callback();
assert.equal(wrapper.style.getPropertyValue('cursor'), 'none', 'cursor hides after leaving slider controls idle');
assert.equal(wrapperVideo.style.getPropertyValue('cursor'), 'none', 'video inline-important cursor hides after controls idle');
assert.equal(wrapperVideo.controls, false, 'native controls hide again after the new idle period');
fireActivity('pointerdown', [wrapperVideo, wrapper]);
assert.equal(wrapperVideo.controls, true, 'pointerdown reveals native controls before a drag');
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 0, 'held pointer prevents idle hiding during drag');
windowListeners.blur.at(-1)();
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 1, 'window blur releases a lost pointer hold safely');
wrapperVideo.dispatch('seeking', { target: wrapperVideo });
assert.equal(wrapperVideo.controls, true, 'active seeking keeps native controls available');
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 0, 'seeking suspends the cursor timer');
wrapperVideo.dispatch('seeked', { target: wrapperVideo });
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 1, 'seeked rearms idle hiding after the lost pointer was cleared');
fireActivity('pointerup', [wrapper]);
assert.equal([...pendingTimers.values()].filter(timer => timer.delay === 2000).length, 1, 'release after seek resumes idle timer');
cursorTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000);
pendingTimers.delete(cursorTimer[0]);
cursorTimer[1].callback();
assert.equal(wrapperVideo.controls, false, 'native controls hide after released seeking becomes idle');
assert.equal(wrapperVideo.style.getPropertyValue('width'), '', 'ambiguous multi-video surfaces do not resize a selected video');
assert.equal(wrapperVideo.style.getPropertyValue('object-fit'), '', 'ambiguous surfaces leave video sizing to the site');
assert.equal(shadowVideo.style.getPropertyValue('width'), '', 'ambiguous open shadow-root video remains untouched');
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'token-wrapper' })).ok, true);
assert.equal(wrapperVideo.style.getPropertyValue('width'), '', 'restore returns descendant video styles');
assert.equal(shadowVideo.style.getPropertyValue('width'), '', 'restore returns open shadow-root video styles');
assert.equal(wrapper.style.getPropertyValue('cursor'), 'crosshair', 'restore returns the wrapper cursor style');
assert.equal(wrapper.style.getPropertyValue('transition'), 'opacity 300ms', 'restore returns the target transition');
assert.equal(wrapper.classList.contains('craig-zone-cursor-hidden'), false, 'restore removes the cursor class');
assert.equal(wrapperVideo.style.getPropertyValue('cursor'), 'pointer', 'restore returns video inline-important cursor');
assert.equal(wrapperVideo.style.getPropertyPriority('cursor'), 'important', 'restore returns video cursor priority');
assert.equal(wrapperVideo.controls, true, 'restore returns originally enabled native controls');
assert.equal(shadowVideo.controls, false, 'restore keeps originally disabled native controls disabled');

const nestedTarget = new FakeElement('section');
const previewSurface = new FakeElement('div');
previewSurface.style.setProperty('width', '320px');
previewSurface.style.setProperty('height', '180px');
previewSurface.style.setProperty('max-width', '320px');
const playerSurface = new FakeElement('div');
playerSurface.style.setProperty('width', '320px');
playerSurface.style.setProperty('height', '180px');
playerSurface.style.setProperty('max-height', '180px');
playerSurface.style.setProperty('padding', '8px');
playerSurface.style.setProperty('border-width', '2px');
const nestedVideo = new FakeVideo();
nestedTarget.appendChild(previewSurface);
previewSurface.appendChild(playerSurface);
playerSurface.appendChild(nestedVideo);
nestedTarget.querySelector = () => nestedVideo;
nestedTarget.querySelectorAll = selector => selector === 'video' ? [nestedVideo] : [previewSurface, playerSurface, nestedVideo];
document.fullscreenElement = nestedTarget;
listeners.fullscreenchange.at(-1)();
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'nested-size', candidateFrameId: 0, candidateKind: 'container-video', role: 'candidate' })).ready, true);
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'nested-size', role: 'candidate' })).ok, true);
for (const wrapperNode of [previewSurface, playerSurface]) {
  assert.equal(wrapperNode.style.getPropertyValue('width'), '100%', 'each unique intermediate player wrapper expands to target width');
  assert.equal(wrapperNode.style.getPropertyValue('height'), '100%', 'each unique intermediate player wrapper expands to target height');
}
assert.equal(previewSurface.style.getPropertyValue('max-width'), 'none', 'fixed preview max-width cannot cap the theater');
assert.equal(playerSurface.style.getPropertyValue('min-height'), '0', 'intermediate min constraints cannot overrun the viewport');
assert.equal(playerSurface.style.getPropertyValue('padding'), '0', 'responsive wrapper padding cannot shrink the selected video');
assert.equal(playerSurface.style.getPropertyValue('border-width'), '0', 'responsive wrapper borders cannot shrink the selected video');
const nestedExit = callMessage({ type: 'CZ_FS_EXIT', token: 'nested-size' });
resolveExit();
for (let i = 0; i < 5; i += 1) await Promise.resolve();
resolveFrame();
assert.equal((await nestedExit).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'nested-size', role: 'candidate' })).ok, true);
const firstGeometryRepair = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 0);
assert.ok(firstGeometryRepair, 'finalize schedules a bounded post-exit geometry repair');
pendingTimers.delete(firstGeometryRepair[0]);
firstGeometryRepair[1].callback();
assert.equal(typeof resolveFrame, 'function', 'geometry repair uses a frame-aligned pass');
resolveFrame();
assert.equal(previewSurface.style.getPropertyValue('width'), '100%', 'immediate post-exit pass retains theater width');
previewSurface.style.setProperty('width', '320px', 'important');
playerSurface.style.setProperty('height', '180px', 'important');
const delayedGeometryRepair = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 180);
assert.ok(delayedGeometryRepair, 'bounded delayed pass covers site styles applied after the first frame');
pendingTimers.delete(delayedGeometryRepair[0]);
delayedGeometryRepair[1].callback();
assert.equal(typeof resolveFrame, 'function', 'delayed correction remains frame-aligned');
resolveFrame();
assert.equal(previewSurface.style.getPropertyValue('width'), '100%', 'delayed pass repairs late inline width from site fullscreen handlers');
assert.equal(playerSurface.style.getPropertyValue('height'), '100%', 'delayed pass repairs late nested player height');
const replacementVideo = new FakeVideo();
nestedVideo.isConnected = false;
playerSurface.children = [replacementVideo];
replacementVideo.parentElement = playerSurface;
playerSurface.style.setProperty('height', '180px', 'important');
const finalGeometryRepair = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 500);
assert.ok(finalGeometryRepair, 'last bounded pass remains scheduled without a permanent observer');
pendingTimers.delete(finalGeometryRepair[0]);
finalGeometryRepair[1].callback();
assert.equal(typeof resolveFrame, 'function');
resolveFrame();
assert.equal(replacementVideo.style.getPropertyValue('width'), '', 'late repair does not rescan and resize a replacement or sibling video');
assert.equal(playerSurface.style.getPropertyValue('height'), '180px', 'wrapper repair stops when its originally confirmed video is gone');
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'nested-size' })).ok, true);
assert.equal(playerSurface.style.getPropertyValue('padding'), '8px', 'restore returns original responsive wrapper padding');
assert.equal(playerSurface.style.getPropertyValue('border-width'), '2px', 'restore returns original wrapper border width');
assert.equal(previewSurface.style.getPropertyValue('width'), '320px', 'nested preview wrapper width restores exactly');
assert.equal(playerSurface.style.getPropertyValue('height'), '180px', 'nested player wrapper height restores exactly');

const rememberedVideo = new FakeVideo();
document.fullscreenElement = rememberedVideo;
listeners.fullscreenchange.at(-1)();
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'manual-memory', candidateFrameId: 0, candidateKind: 'video', role: 'candidate' })).ready, true);
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'manual-memory', role: 'candidate' })).ok, true);
const memoryExit = callMessage({ type: 'CZ_FS_EXIT', token: 'manual-memory' });
resolveExit();
for (let i = 0; i < 5; i += 1) await Promise.resolve();
resolveFrame();
assert.equal((await memoryExit).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'manual-memory', role: 'candidate' })).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'manual-memory' })).ok, true);
rememberedVideo.paused = false;
rememberedVideo.readyState = 4;
deliver({ type: 'CZ_STATE', enabled: true, active: false, autoFullscreenAllowed: true, slot: 2, total: 8, label: 'Game Two' });
const autoVideo = new FakeVideo();
fireActivity('pointerdown', [autoVideo]);
autoVideo.paused = false;
autoVideo.readyState = 4;
firePlayerEvent('playing', autoVideo);
assert.equal(messages.some(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic), false,
  'inactive tab cannot auto-expand a directly clicked video');
deliver({ type: 'CZ_STATE', enabled: true, active: true, autoFullscreenAllowed: false, slot: 2, total: 8, label: 'Game Two' });
fireActivity('pointerdown', [autoVideo]);
firePlayerEvent('click', autoVideo);
assert.equal(messages.some(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic), false,
  'per-tab auto opt-out blocks direct-video expansion');
deliver({ type: 'CZ_STATE', enabled: true, active: true, autoFullscreenAllowed: true, slot: 2, total: 8, label: 'Game Two' });
const returnCandidate = messages.findLast(message => message.type === 'CZ_FS_CANDIDATE');
assert.equal(returnCandidate?.automatic, true, 'returning to the active tab auto-expands its exact manually confirmed video when playing');
const returnPrepare = await callMessage({ type: 'CZ_FS_PREPARE', token: 'return-token', candidateFrameId: 0, candidateKind: 'video', role: 'candidate', automatic: true });
assert.equal(returnPrepare.ready, true, 'remembered manual video stays the exact automatic preparation target');
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'return-token', role: 'candidate', automatic: true })).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'return-token', role: 'candidate', automatic: true })).ok, true);
assert.equal(rememberedVideo.style.getPropertyValue('position'), 'fixed', 'return path expands only the confirmed video');
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'return-token' })).ok, true);
rememberedVideo.paused = true;
rememberedVideo.readyState = 0;
const customVideo = new FakeVideo();
const customContainer = new FakeElement('div');
customContainer.descendants = [customVideo];
const playButton = new FakeElement('button');
playButton.setAttribute('aria-label', 'Play game');
customContainer.appendChild(playButton);
const beforeCustomPlay = messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length;
fireActivity('pointerdown', [playButton, customContainer]);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, beforeCustomPlay, 'a trusted custom Play control waits for actual playback');
customVideo.paused = false; customVideo.readyState = 4;
firePlayerEvent('playing', customVideo);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, beforeCustomPlay + 1, 'playing after a deliberate custom Play click requests theater without a fullscreen click');
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'custom-play', candidateFrameId: 0, candidateKind: 'video', role: 'candidate', automatic: true })).ready, true);
await callMessage({ type: 'CZ_FS_ABORT', token: 'custom-play' });
customVideo.paused = true;
customContainer.descendants = [customVideo, new FakeVideo()];
const beforeAmbiguous = messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length;
fireActivity('pointerdown', [playButton, customContainer]);
customVideo.paused = false;
firePlayerEvent('playing', customVideo);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, beforeAmbiguous, 'a Play control containing multiple visible videos keeps selection manual');
customVideo.paused = true;
const candidateCountAfterReturn = messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length;
const tinyVideo = new FakeVideo();
tinyVideo.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 90, width: 120, height: 90 });
fireActivity('pointerdown', [tinyVideo]);
tinyVideo.paused = false;
tinyVideo.readyState = 4;
firePlayerEvent('click', tinyVideo);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, candidateCountAfterReturn,
  'small/ineligible video cannot trigger auto theater');
fireActivity('pointerdown', [autoVideo], false);
firePlayerEvent('click', autoVideo, false);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, candidateCountAfterReturn,
  'synthetic/untrusted direct video events cannot trigger auto theater');
fireActivity('pointerdown', [autoVideo]);
firePlayerEvent('click', autoVideo);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, candidateCountAfterReturn,
  'clicking an already-playing video does not expand while the user may be pausing or seeking');
autoVideo.paused = true;
autoVideo.readyState = 0;
fireActivity('pointerdown', [autoVideo]);
firePlayerEvent('click', autoVideo);
assert.equal(messages.filter(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic).length, candidateCountAfterReturn,
  'paused click only arms the exact video and never expands before playback');
autoVideo.paused = false;
autoVideo.readyState = 4;
firePlayerEvent('playing', autoVideo);
const automaticCandidate = messages.findLast(message => message.type === 'CZ_FS_CANDIDATE' && message.automatic);
assert.deepEqual({ type: automaticCandidate?.type, kind: automaticCandidate?.kind, automatic: automaticCandidate?.automatic },
  { type: 'CZ_FS_CANDIDATE', kind: 'video', automatic: true }, 'playing event on the exact trusted video requests automatic theater');
const autoPrepare = await callMessage({ type: 'CZ_FS_PREPARE', token: 'auto-token', candidateFrameId: 0, candidateKind: 'video', role: 'candidate', automatic: true });
assert.equal(autoPrepare.ready, true, 'automatic preflight resolves the exact clicked-and-playing video without native fullscreen');
assert.equal((await callMessage({ type: 'CZ_FS_STAGE', token: 'auto-token', role: 'candidate', automatic: true })).ok, true);
assert.equal((await callMessage({ type: 'CZ_FS_APPLY', token: 'auto-token', role: 'candidate', automatic: true })).ok, true,
  'automatic mode finalizes after staged CSS without requesting native player fullscreen');
assert.equal(autoVideo.style.getPropertyValue('position'), 'fixed', 'only the exact selected video is expanded');
assert.equal(document.fullscreenElement, null, 'automatic theater does not call native fullscreen');
document.fullscreenElement = autoVideo;
window.top = {};
listeners.fullscreenchange.at(-1)();
assert.equal(messages.filter(message => message.type === 'CZ_FS_RESTORE_REQUEST' && message.nativeExit).length, 0,
  'child frame suppresses duplicate native-fullscreen restore requests');
window.top = window;
listeners.fullscreenchange.at(-1)();
const nativeRestore = messages.findLast(message => message.type === 'CZ_FS_RESTORE_REQUEST');
assert.deepEqual({ token: nativeRestore?.token, optOut: nativeRestore?.optOut, nativeExit: nativeRestore?.nativeExit },
  { token: 'auto-token', optOut: true, nativeExit: true }, 'top frame requests one coordinated native exit and records opt-out');
const nativeExitPromise = callMessage({ type: 'CZ_FS_NATIVE_EXIT', token: 'auto-token' });
assert.equal(exitCalls, 4, 'background native-exit command is performed exactly once by frame 0');
resolveExit();
for (let i = 0; i < 5; i += 1) await Promise.resolve();
assert.equal(typeof resolveFrame, 'function', 'native restore ACK waits for the browser exit frame');
resolveFrame();
assert.equal((await nativeExitPromise).ok, true, 'native exit ACK follows actual fullscreen cleanup');
assert.equal((await callMessage({ type: 'CZ_FS_RESTORE', token: 'auto-token' })).ok, true);
assert.equal(autoVideo.style.getPropertyValue('position'), '', 'automatic theater restores original page styles');

windowListeners.pagehide.at(-1)({ persisted: true });
assert.equal(runtimeListeners.length, 1, 'bfcache pagehide preserves listeners');
stateResponse = { type: 'CZ_STATE', enabled: true, slot: 2, total: 8, label: 'Game Two' };
windowListeners.pageshow.at(-1)({ persisted: true });
await Promise.resolve();
assert.equal(messages.filter(m => m.type === 'CZ_STATE').length, 2, 'bfcache restore refreshes state');
frames = [childFrame];
childFrame.style.setProperty('cursor', 'crosshair');
const stopVideo = new FakeVideo();
stopVideo.controls = true;
childFrame.querySelectorAll = selector => selector === 'video' ? [stopVideo] : [];
assert.equal((await callMessage({ type: 'CZ_FS_PREPARE', token: 'token-stop', candidateFrameId: 5, candidateKind: 'video', role: 'ancestor', childFrameId: 6, childUrl: 'https://player.example/embed?id=1' })).ready, true);
const stopStage = await callMessage({ type: 'CZ_FS_STAGE', token: 'token-stop', role: 'ancestor' });
assert.equal(stopStage.ok, true, JSON.stringify(stopStage));
cursorTimer = [...pendingTimers.entries()].find(([, timer]) => timer.delay === 2000);
pendingTimers.delete(cursorTimer[0]);
cursorTimer[1].callback();
assert.equal(childFrame.style.getPropertyValue('cursor'), 'none', 'cursor hides before stop cleanup');
assert.equal(stopVideo.controls, false, 'stop target hides native controls only during idle theater');
deliver({ type: 'CZ_STOP' });
assert.equal(runtimeListeners.length, 0, 'stop removes the runtime listener');
assert.equal((listeners.keydown || []).length, 0, 'stop removes the keyboard listener');
assert.equal((listeners.pointerdown || []).length, 0, 'stop removes the cursor activity listener');
assert.equal((windowListeners.resize || []).length, 0, 'stop removes the fullscreen recovery resize listener');
assert.equal((windowListeners.blur || []).length, 0, 'stop removes the lost-pointer recovery listener');
assert.equal(childFrame.style.getPropertyValue('cursor'), 'crosshair', 'stop restores the page cursor style');
assert.equal(stopVideo.controls, true, 'stop restores native controls that were originally enabled');
assert.equal(childFrame.classList.contains('craig-zone-cursor-hidden'), false, 'stop removes the cursor class');
assert.equal(root.children[0].isConnected, false, 'stop removes the transient overlay');
console.log('content pilot mocks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
