// Real Chromium-engine smoke test. Requires a Chromium-family binary and a built extension.
// Uses only a fresh temporary profile and local synthetic HTTP pages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [browserBinary, builtExtension, extensionId] = process.argv.slice(2);
assert(browserBinary && builtExtension && extensionId, "usage: node tests/test-browser.cjs BROWSER_BINARY BUILT_EXTENSION EXTENSION_ID");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "craig-zone-chromium-") );
const evidenceRoot = process.env.CZ_CHROMIUM_EVIDENCE_DIR || path.join(os.tmpdir(), `craig-zone-chromium-evidence-${process.pid}`);
fs.mkdirSync(evidenceRoot, { recursive: true });
const profile = path.join(temporaryRoot, "profile");
const testExtension = path.join(temporaryRoot, "extension");
fs.cpSync(builtExtension, testExtension, { recursive: true });
const manifestPath = path.join(testExtension, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
// Preserve API permissions from the shipped manifest so a missing namespace
// fails this test. Only fixture-site access is pregranted for automation.
assert(manifest.permissions.includes("webNavigation"), "frame inspection must be available at load time");
manifest.host_permissions = ["http://127.0.0.1/*", "http://localhost/*"];
delete manifest.optional_host_permissions;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

let browserProcess;
let browserSocket;
let server;
let childServer;
const pending = new Map();
const serviceWorkerVersions = [];
let nextId = 1;
let browserOutput = "";

function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  browserSocket.send(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Browser request timed out: ${method}`));},15000);
    pending.set(id, { resolve, reject, method, timer });
  });
}

async function attachTarget(targetId) {
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  return sessionId;
}

async function evaluate(sessionId, expression) {
  const userGesture = arguments[2] === true;
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function evaluateContext(sessionId, contextId, expression, userGesture = false) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture, contextId }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function openPage(url) {
  const { targetId } = await cdp("Target.createTarget", { url });
  return { targetId, sessionId: await attachTarget(targetId) };
}

async function waitFor(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const videoHtml = '<!doctype html><title>Synthetic video geometry</title><style>html,body{margin:0;overflow-y:scroll;scrollbar-gutter:stable}#wrapper{width:320px;height:180px;overflow:hidden;contain:paint;transform:translate(18px,12px)}video{width:320px;height:180px}#filler{height:2500px}</style><div id="wrapper"><video id="player" controls></video></div><div id="filler"></div><script>const c=document.createElement("canvas");c.width=320;c.height=180;c.getContext("2d").fillRect(0,0,320,180);const v=document.getElementById("player");v.srcObject=c.captureStream(8);v.muted=true;</script>';
  childServer = http.createServer((request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(videoHtml); });
  await new Promise((resolve) => childServer.listen(0, "127.0.0.1", resolve));
  const childOrigin = `http://127.0.0.1:${childServer.address().port}`;
  server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/embedded") {
      response.end(`<!doctype html><title>Synthetic embedded game</title><style>html,body{margin:0;overflow-y:scroll;scrollbar-gutter:stable}#clip{width:320px;height:180px;overflow:hidden;contain:paint;transform:translate(22px,14px)}iframe{width:320px;height:180px;border:0}#filler{height:2500px}</style><div id="clip"><iframe allowfullscreen src="${childOrigin}/player"></iframe></div><div id="filler"></div>`);
    } else if (request.url === "/custom-player") {
      response.end(videoHtml.replace('<video id="player" controls></video>', '<video id="player" controls></video><button id="custom-play" aria-label="Play game" style="position:absolute;left:10px;top:10px;z-index:3">Play</button>').replace('v.muted=true;', 'v.muted=true;document.querySelector("#custom-play").onclick=()=>v.play();'));
    } else if (request.url === "/video" || request.url === "/player") {
      response.end(videoHtml);
    } else response.end(`<!doctype html><title>Synthetic CraigZone page</title><input id="typing"><main>${request.url}</main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browserHome=path.join(temporaryRoot,"home");fs.mkdirSync(browserHome);
  const browserEnv=Object.fromEntries(["PATH","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","CHROME_DEVEL_SANDBOX"].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  Object.assign(browserEnv,{HOME:browserHome,XDG_CONFIG_HOME:path.join(browserHome,"config"),XDG_CACHE_HOME:path.join(browserHome,"cache")});
  browserProcess = spawn(browserBinary, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", `--user-data-dir=${profile}`,
    `--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`,
    "--remote-debugging-port=0", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"], env:browserEnv });
  browserProcess.stderr.on("data", (chunk) => { browserOutput = `${browserOutput}${chunk}`.slice(-5000); });

  const activePortFile = path.join(profile, "DevToolsActivePort");
  const port = await waitFor(() => {
    try { return Number(fs.readFileSync(activePortFile, "utf8").split("\n")[0]); }
    catch { return null; }
  }, "DevTools endpoint");
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  browserSocket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserSocket.addEventListener("open", resolve, { once: true });
    browserSocket.addEventListener("error", reject, { once: true });
  });
  browserSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "ServiceWorker.workerVersionUpdated") serviceWorkerVersions.push(...(message.params.versions || []));
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result || {});
    }
  });

  const pageA = await openPage(`${origin}/game-a`);
  const pageB = await openPage(`${origin}/game-b`);
  await waitFor(async () => (await evaluate(pageA.sessionId, "document.readyState")) === "complete", "synthetic page A");
  await waitFor(async () => (await evaluate(pageB.sessionId, "document.readyState")) === "complete", "synthetic page B");
  const popup = await openPage(`chrome-extension://${extensionId}/popup.html`);
  console.log('Browser and extension controls ready.');
  await cdp("Emulation.setDeviceMetricsOverride", { width: 520, height: 900, deviceScaleFactor: 1, mobile: false }, popup.sessionId);
  await waitFor(async () => await evaluate(popup.sessionId, "document.readyState") === "complete", "extension popup page");
  const popupInfo = await evaluate(popup.sessionId, `(()=>{const main=document.querySelector('main');const box=main.getBoundingClientRect();return {title:document.title,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,main:{x:box.x,y:box.y,width:box.width,height:box.height},hasStart:!!document.getElementById('start'),text:document.body.innerText.slice(0,180)}})()`);
  assert.equal(popupInfo.title, "CraigZone");
  assert.equal(popupInfo.hasStart, true);
  await waitFor(async () => evaluate(popup.sessionId,"document.body.classList.contains('full-page')"), "larger controls mode for a full browser tab");
  const responsiveLayouts=[];
  for(const width of [320,720,1920,3840]) {
    await cdp("Emulation.setDeviceMetricsOverride",{width,height:1080,deviceScaleFactor:1,mobile:false},popup.sessionId);
    const layout=await evaluate(popup.sessionId,"({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.getBoundingClientRect().width})");
    assert(layout.scrollWidth<=layout.width,`controls overflow at ${width}px: ${JSON.stringify(layout)}`);
    responsiveLayouts.push(layout);
  }
  await cdp("Emulation.setDeviceMetricsOverride",{width:520,height:900,deviceScaleFactor:1,mobile:false},popup.sessionId);
  const worker = await waitFor(async () => {
    const targets = await cdp("Target.getTargets");
    return targets.targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  }, `MV3 service worker startup. Browser output: ${browserOutput}`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, popup.sessionId);
  const screenshotPath = path.join(evidenceRoot, "popup.png");
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const selectedA = await evaluate(popup.sessionId, `(async()=>{
    const a=(await browser.tabs.query({})).find(t=>t.url==='${origin}/game-a');
    for(const input of document.querySelectorAll('#tabs input')) {
      input.checked=Number(input.value)===a.id;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return a.id;
  })()`);
  const added = await openPage(`${origin}/late-game`);
  await waitFor(async () => (await evaluate(popup.sessionId, "document.querySelectorAll('#tabs input').length")) === 3, "new game appears without refreshing controls");
  assert(await evaluate(popup.sessionId, `document.querySelector('#tabs input[value="${selectedA}"]').checked`), "live refresh preserves selection");
  await evaluate(added.sessionId, "document.title='Updated synthetic game'");
  await waitFor(async () => (await evaluate(popup.sessionId, "document.querySelector('#tabs').textContent")).includes('Updated synthetic game'), "updated game title appears automatically");
  await cdp("Target.closeTarget", { targetId: added.targetId });
  await waitFor(async () => (await evaluate(popup.sessionId, "document.querySelectorAll('#tabs input').length")) === 2, "closed game disappears automatically");
  assert(await evaluate(popup.sessionId, `document.querySelector('#tabs input[value="${selectedA}"]').checked`), "closing another tab preserves selection");

  const startResult = await evaluate(popup.sessionId, `(async()=>{
    const tabs=await browser.tabs.query({});
    const a=tabs.find(t=>t.url==='${origin}/game-a');
    const b=tabs.find(t=>t.url==='${origin}/game-b');
    if(!a||!b) throw Error('fixture tabs unavailable '+JSON.stringify(tabs));
    globalThis.__czTabIds={a:a.id,b:b.id,windowId:a.windowId};
    await browser.tabs.update(a.id,{muted:true});
    await browser.tabs.update(b.id,{muted:true});
    if(typeof browser.webNavigation?.getAllFrames!=='function') throw Error('getAllFrames unavailable in popup');
    for(const input of document.querySelectorAll('#tabs input')) {
      input.checked=[a.id,b.id].includes(Number(input.value));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    document.querySelector('#start').click();
    return {clicked:true};
  })()`, true);
  assert(startResult.clicked);
  const popupStarted = await waitFor(async () => {
    const check = await evaluate(popup.sessionId, `(async()=>({session:await browser.runtime.sendMessage({type:'CZ_GET_SESSION'}),error:document.querySelector('#error').textContent}))()`);
    assert.equal(check.error, "", `Start button failed: ${check.error}`);
    return check.session.enabled ? check.session : null;
  }, "session startup through the popup Start button");
  startResult.ok = popupStarted.enabled;
  console.log('Popup startup and audio checks ready.');
  assert.equal(startResult.ok, true, `session start failed: ${JSON.stringify(startResult)}`);

  const tabsState = () => evaluate(popup.sessionId, `(async()=>{
    const ids=globalThis.__czTabIds;
    const a=await browser.tabs.get(ids.a),b=await browser.tabs.get(ids.b);
    return {aActive:a.active,aMuted:a.mutedInfo.muted,bActive:b.active,bMuted:b.mutedInfo.muted};
  })()`);
  let state = await tabsState();
  assert.equal(state.aActive, true);
  assert.equal(state.aMuted, false, "Start unmutes the active tab even if it began muted");
  assert.equal(state.bMuted, true);
  await evaluate(popup.sessionId,"(async()=>{const current=await browser.tabs.getCurrent();await browser.tabs.update(current.id,{active:true})})()");
  await waitFor(async()=> (await tabsState()).aMuted===false,"opening full controls preserves the current game's audio");
  await evaluate(popup.sessionId,"browser.runtime.sendMessage({type:'CZ_WATCH_GAME',tabId:globalThis.__czTabIds.a})");

  await evaluate(pageA.sessionId, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,cancelable:true}))");
  await waitFor(async () => (await tabsState()).aMuted === true, "M mute on the active synthetic game");
  await evaluate(pageA.sessionId, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,cancelable:true}))");
  await waitFor(async () => (await tabsState()).aMuted === false, "M unmute on the active synthetic game");
  await evaluate(pageA.sessionId, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))");
  await waitFor(async () => {
    const current = await tabsState();
    return current.bActive && current.aMuted;
  }, "ArrowRight switch and outgoing-tab mute");

  await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, popup.sessionId);
  const sessionBeforeRestart = await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_GET_SESSION'})");
  assert.equal(sessionBeforeRestart.enabled, true);
  const currentTargets = await cdp("Target.getTargets");
  const workerTarget = currentTargets.targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  assert(workerTarget, "service worker target disappeared before restart check");
  const workerDebugSession = (await cdp("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true })).sessionId;
  let restartMethod;
  try {
    await cdp("ServiceWorker.enable", {}, workerDebugSession);
    const workerVersion = await waitFor(() => serviceWorkerVersions.find((version) => version.scriptURL.startsWith(`chrome-extension://${extensionId}/service-worker.js`) && version.status === "activated")?.versionId, "activated service worker version");
    await cdp("ServiceWorker.stopWorker", { versionId: workerVersion });
    await waitFor(() => serviceWorkerVersions.some((version) => version.versionId === workerVersion && version.runningStatus === "stopped"), "service worker stop");
    restartMethod = "ServiceWorker.stopWorker";
  } catch (error) {
    if (!String(error.message).includes("wasn't found")) throw error;
    await cdp("Target.closeTarget", { targetId: workerTarget.targetId });
    restartMethod = "Target.closeTarget (ServiceWorker CDP domain unavailable)";
  }
  const sessionAfterRestart = await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_GET_SESSION'})");
  console.log('Service-worker recovery checked.');
  assert.equal(sessionAfterRestart.enabled, true, "session storage restored after the MV3 worker restarted");
  state = await tabsState();
  assert.equal(state.bActive, true);
  assert.equal(state.aMuted, true);
  const gameC = await openPage(`${origin}/game-c`);
  await waitFor(async () => (await evaluate(popup.sessionId, "document.querySelectorAll('#tabs input').length")) === 3, "new game appears during a running session");
  await evaluate(popup.sessionId, "document.querySelector('#edit-games').click()");
  await waitFor(async () => await evaluate(popup.sessionId, "!document.querySelector('#start').hidden"), "live lineup editing controls");
  await evaluate(popup.sessionId, `(async()=>{
    const c=(await browser.tabs.query({})).find(t=>t.url==='${origin}/game-c');
    globalThis.__czTabIds.c=c.id;
    const input=document.querySelector('#tabs input[value="'+c.id+'"]');
    input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#start').click();
  })()`, true);
  const liveEdited = await waitFor(async () => {
    const s=await evaluate(popup.sessionId,"browser.runtime.sendMessage({type:'CZ_GET_SESSION'})");
    return s.tabs.length===3?s:null;
  }, "new game joins through Check players and apply");
  assert.equal(liveEdited.activeId, sessionBeforeRestart.activeId, "lineup editing returns to the existing game");
  assert.deepEqual(liveEdited.tabs.map(t=>t.slot),[1,2,3]);
  const editCounts = await evaluate(popup.sessionId,"browser.runtime.sendMessage({type:'CZ_DIAGNOSTICS_GET'})");
  const actionCounts=Object.values(editCounts.days).reduce((a,row)=>({starts:a.starts+(row.actions.starts||0),stops:a.stops+(row.actions.stops||0),edits:a.edits+(row.actions.edits||0)}),{starts:0,stops:0,edits:0});
  assert.deepEqual(actionCounts,{starts:1,stops:0,edits:1},"a live edit preserves the session without a stop/start cycle");
  console.log('Live lineup edit checked.');
  await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_STOP_SESSION'})");

  const videoPage = await openPage(`${origin}/video`);
  await waitFor(async () => await evaluate(videoPage.sessionId, "document.readyState") === "complete" && await evaluate(videoPage.sessionId, "document.querySelector('video').readyState") >= 2, "synthetic video fixture");
  const videoStart = await evaluate(popup.sessionId, `(async()=>{
    const tabs=await browser.tabs.query({});
    const video=tabs.find(t=>t.url==='${origin}/video');
    const background=tabs.find(t=>t.url==='${origin}/game-b');
    globalThis.__czVideoIds={video:video.id,background:background.id,windowId:video.windowId};
    await browser.tabs.update(video.id,{active:true});
    return await browser.runtime.sendMessage({type:'CZ_START',ids:[video.id,background.id],windowId:video.windowId});
  })()`);
  assert.equal(videoStart.ok, true, `video geometry session failed: ${JSON.stringify(videoStart)}`);
  await evaluate(videoPage.sessionId, "document.querySelector('video').play()");
  await evaluate(videoPage.sessionId, "document.querySelector('video').requestFullscreen()", true);
  const videoGeometry = await waitFor(async () => {
    const geometry = await evaluate(videoPage.sessionId, `(()=>{const v=document.querySelector('video');const r=v.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,nativeFullscreen:!!document.fullscreenElement}})()`);
    return !geometry.nativeFullscreen && Math.abs(geometry.x)<3 && Math.abs(geometry.y)<3 && Math.abs(geometry.width-geometry.viewportWidth)<3 && Math.abs(geometry.height-geometry.viewportHeight)<3 ? geometry : null;
  }, "expanded synthetic video viewport geometry");
  const viewportScrollExpression = `(()=>({root:getComputedStyle(document.documentElement).overflowY,body:getComputedStyle(document.body).overflowY,gutter:getComputedStyle(document.documentElement).scrollbarGutter}))()`;
  const videoScrolling = await evaluate(videoPage.sessionId, viewportScrollExpression);
  assert.deepEqual(videoScrolling, {root:'hidden',body:'hidden',gutter:'auto'}, "direct fullscreen suppresses forced page scrollbars");
  const videoScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, videoPage.sessionId);
  const videoScreenshotPath = path.join(evidenceRoot, "video.png");
  fs.writeFileSync(videoScreenshotPath, Buffer.from(videoScreenshot.data, "base64"));
  const liveFullscreenEdit = await evaluate(popup.sessionId, `(async()=>{
    const s=await browser.runtime.sendMessage({type:'CZ_GET_SESSION'});
    const c=(await browser.tabs.query({})).find(t=>t.url==='${origin}/game-c');
    return browser.runtime.sendMessage({type:'CZ_UPDATE_SESSION',ids:[...s.tabs.map(t=>t.id),c.id],windowId:s.windowId});
  })()`);
  assert.equal(liveFullscreenEdit.ok,true,"a game can join a session in theater mode");
  const preservedGeometry = await evaluate(videoPage.sessionId,"(()=>{const r=document.querySelector('video').getBoundingClientRect();return {width:r.width,height:r.height,w:innerWidth,h:innerHeight}})()");
  assert(Math.abs(preservedGeometry.width-preservedGeometry.w)<3&&Math.abs(preservedGeometry.height-preservedGeometry.h)<3,"live edit preserves the expanded active video");
  console.log('Direct player geometry and live theater edit checked.');
  await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_STOP_SESSION'})");
  const restoredVideo = await evaluate(videoPage.sessionId, `(()=>{const r=document.querySelector('video').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
  assert(Math.abs(restoredVideo.width - 320) < 1 && Math.abs(restoredVideo.height - 180) < 1, `stop did not restore synthetic video size: ${JSON.stringify(restoredVideo)}`);
  assert.deepEqual(await evaluate(videoPage.sessionId, viewportScrollExpression), {root:'scroll',body:'scroll',gutter:'stable'}, "Stop restores page scrolling and reserved gutter");

  const customPage = await openPage(`${origin}/custom-player`);
  await waitFor(async()=>await evaluate(customPage.sessionId,"!!document.querySelector('#custom-play')"),"custom Play fixture");
  const customStart=await evaluate(popup.sessionId,`(async()=>{
    const tabs=await browser.tabs.query({});const game=tabs.find(t=>t.url==='${origin}/custom-player'),other=tabs.find(t=>t.url==='${origin}/game-b');
    await browser.tabs.update(game.id,{active:true});
    return browser.runtime.sendMessage({type:'CZ_START',ids:[game.id,other.id],windowId:game.windowId});
  })()`);
  assert.equal(customStart.ok,true);
  assert.equal(await evaluate(customPage.sessionId,"document.querySelector('video').paused"),true,"Start preserves manual playback control");
  const playPoint=await evaluate(customPage.sessionId,"(()=>{const r=document.querySelector('#custom-play').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...playPoint},customPage.sessionId);
  await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...playPoint},customPage.sessionId);
  const customGeometry=await waitFor(async()=>{
    const g=await evaluate(customPage.sessionId,"(()=>{const v=document.querySelector('video'),r=v.getBoundingClientRect();return {paused:v.paused,width:r.width,height:r.height,w:innerWidth,h:innerHeight,native:!!document.fullscreenElement}})()");
    return !g.paused&&!g.native&&Math.abs(g.width-g.w)<3&&Math.abs(g.height-g.h)<3?g:null;
  },"one deliberate custom Play click expands the video without autoplay or a fullscreen click");
  console.log('Deliberate custom Play expansion checked.');
  await evaluate(popup.sessionId,"browser.runtime.sendMessage({type:'CZ_STOP_SESSION'})");
  await cdp("Target.closeTarget",{targetId:customPage.targetId});
  const embeddedPage = await openPage(`${origin}/embedded`);
  const frameTree = await waitFor(async () => {
    const result = await cdp("Page.getFrameTree", {}, embeddedPage.sessionId);
    const child = result.frameTree.childFrames?.find((item) => item.frame.url.startsWith(`${childOrigin}/player`));
    return child ? { result, child } : null;
  }, "synthetic cross-origin player frame");
  const childContext = await cdp("Page.createIsolatedWorld", { frameId: frameTree.child.frame.id, worldName: "craig-zone-test" }, embeddedPage.sessionId);
  await waitFor(async () => evaluate(popup.sessionId, `(async()=>{const game=(await browser.tabs.query({})).find(t=>t.url==='${origin}/embedded');return !!game&&!!document.querySelector('#tabs input[value="'+game.id+'"]');})()`), "the exact embedded game appears without refreshing controls");
  await waitFor(async()=>await evaluate(popup.sessionId,"!document.querySelector('#start').hidden && document.querySelector('#edit-games').hidden"),"controls reflect the completed session stop");
  await evaluate(popup.sessionId, `(async()=>{
    const tabs=await browser.tabs.query({});
    const embedded=tabs.find(t=>t.url==='${origin}/embedded');
    const background=tabs.find(t=>t.url==='${origin}/game-b');
    globalThis.__czEmbeddedIds={embedded:embedded.id,background:background.id,windowId:embedded.windowId};
    for(const input of document.querySelectorAll('#tabs input')) {
      input.checked=[embedded.id,background.id].includes(Number(input.value));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    const button=document.querySelector('#start');
    if(button.disabled) throw new Error('Embedded selection left Start disabled: '+JSON.stringify([...document.querySelectorAll('#tabs input')].map(i=>({id:i.value,checked:i.checked,disabled:i.disabled}))));
    button.click();
  })()`, true);
  const embeddedStart = await waitFor(async () => {
    const check = await evaluate(popup.sessionId, `(async()=>({session:await browser.runtime.sendMessage({type:'CZ_GET_SESSION'}),error:document.querySelector('#error').textContent}))()`);
    assert.equal(check.error, "", `embedded Start button failed: ${check.error}`);
    return check.session.enabled ? check.session : null;
  }, "embedded-player session startup through the popup");
  assert(embeddedStart.tabs.some(tab => tab.playerOrigins?.includes(childOrigin)), "Start must discover the embedded player origin");
  await evaluate(popup.sessionId, "browser.tabs.update(globalThis.__czEmbeddedIds.embedded,{active:true})");
  await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, "document.querySelector('video').play()");
  await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, "document.querySelector('video').requestFullscreen()", true);
  const embeddedGeometry = await waitFor(async () => {
    const outer = await evaluate(embeddedPage.sessionId, `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,nativeFullscreen:!!document.fullscreenElement}})()`);
    const inner = await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, `(()=>{const r=document.querySelector('video').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,nativeFullscreen:!!document.fullscreenElement}})()`);
    const fills = (geometry) => !geometry.nativeFullscreen && Math.abs(geometry.x)<3 && Math.abs(geometry.y)<3 && Math.abs(geometry.width-geometry.viewportWidth)<3 && Math.abs(geometry.height-geometry.viewportHeight)<3;
    return fills(outer) && fills(inner) ? { outer, inner } : null;
  }, "coordinated cross-origin iframe and video geometry");
  const embeddedScrolling = {
    outer: await evaluate(embeddedPage.sessionId, viewportScrollExpression),
    inner: await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, viewportScrollExpression)
  };
  for (const documentScrolling of Object.values(embeddedScrolling)) {
    assert.deepEqual(documentScrolling, {root:'hidden',body:'hidden',gutter:'auto'}, "both embedded documents suppress forced scrollbars");
  }
  const embeddedSessionState = await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_GET_SESSION'})");
  assert.equal(embeddedSessionState.warning, "", `coordinated iframe expansion reported a warning: ${embeddedSessionState.warning}`);
  await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))");
  await waitFor(async () => await evaluate(popup.sessionId, `(async()=>{const t=await browser.tabs.query({});return t.find(x=>x.url==='${origin}/game-b')?.active})()`), "arrow-key switching from the cross-origin player frame");
  const embeddedScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, embeddedPage.sessionId);
  const embeddedScreenshotPath = path.join(evidenceRoot, "embedded.png");
  fs.writeFileSync(embeddedScreenshotPath, Buffer.from(embeddedScreenshot.data, "base64"));
  await evaluate(popup.sessionId, "browser.runtime.sendMessage({type:'CZ_STOP_SESSION'})");
  const restoredIframe = await evaluate(embeddedPage.sessionId, `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
  assert(Math.abs(restoredIframe.width - 320) < 1 && Math.abs(restoredIframe.height - 180) < 1, `stop did not restore cross-origin iframe size: ${JSON.stringify(restoredIframe)}`);
  assert.deepEqual(await evaluate(embeddedPage.sessionId, viewportScrollExpression), {root:'scroll',body:'scroll',gutter:'stable'}, "Stop restores the outer page scrollbars");
  assert.deepEqual(await evaluateContext(embeddedPage.sessionId, childContext.executionContextId, viewportScrollExpression), {root:'scroll',body:'scroll',gutter:'stable'}, "Stop restores embedded document scrollbars");

  const report = { browser: version.Browser, popup: popupInfo, responsiveLayouts, manualPlayExpansion: customGeometry, liveLineupEditing: true, liveFullscreenEdit: true, liveTabList: true, preservesSelection: true, initiallyMutedActiveTabUnmuted: true, startResult, switchAndMute: state, sessionRestoredAfterWorkerStop: sessionAfterRestart.enabled, restartMethod, videoGeometry, videoScrolling, restoredVideo, embeddedGeometry, embeddedScrolling, embeddedSessionState, restoredIframe, screenshotPath, videoScreenshotPath, embeddedScreenshotPath };
  fs.writeFileSync(path.join(evidenceRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}

run().catch((error) => {
  console.error(error.stack || error);
  if (browserOutput) console.error(browserOutput);
  process.exitCode = 1;
}).finally(async () => {
  try { if (browserSocket) browserSocket.close(); } catch {}
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => browserProcess.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill("SIGKILL");
      await new Promise((resolve) => browserProcess.once("exit", resolve));
    }
  }
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch {}
  try { if (childServer) await new Promise((resolve) => childServer.close(resolve)); } catch {}
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
});
