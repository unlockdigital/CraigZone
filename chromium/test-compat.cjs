// Synthetic browser API test for the Firefox-to-Chromium onMessage adapter.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = new Set();
const tabRemovedListeners = new Set();
const chrome = {
  tabs: { onRemoved: { addListener(listener) { tabRemovedListeners.add(listener); } } },
  runtime: {
    onMessage: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    },
    getURL(path) { return `chrome-extension://synthetic/${path}`; }
  }
};
const context = vm.createContext({ chrome, console, WeakMap, Promise, setTimeout });
const shimSource = fs.readFileSync(`${__dirname}/compat.js`, "utf8");
vm.runInContext(shimSource, context);

async function dispatch(message) {
  const listener = [...listeners][0];
  let response;
  let calls = 0;
  const keepOpen = listener(message, { tab: { id: 7 } }, (value) => { calls += 1; response = value; });
  if (keepOpen === true) await new Promise((resolve) => setTimeout(resolve, 0));
  return { keepOpen, calls, response };
}

(async () => {
  assert.equal(context.browser.runtime.getURL("popup.html"), "chrome-extension://synthetic/popup.html");
  assert.equal(context.CraigZoneChromium.isTrustedPopupSender({ url: "chrome-extension://synthetic/popup.html", tab: { id: 8 } }), true);
  assert.equal(context.CraigZoneChromium.isTrustedPopupSender({ url: "https://example.invalid/popup.html", tab: { id: 8 } }), false);
  assert.equal(context.CraigZoneChromium.isTrustedPopupSender({ url: "chrome-extension://synthetic/options.html" }), false);
  const stableBrowser = context.browser;
  const originalListener = () => undefined;
  context.browser.runtime.onMessage.addListener(originalListener);
  const originalAdapter = [...listeners][0];
  vm.runInContext(shimSource, context);
  assert.equal(context.browser, stableBrowser);
  context.browser.runtime.onMessage.removeListener(originalListener);
  assert.equal(listeners.has(originalAdapter), false);
  context.browser.runtime.onMessage.addListener((message) => Promise.resolve({ ok: message.ok }));
  let result = await dispatch({ ok: true });
  assert.equal(result.keepOpen, true);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.response, { ok: true });

  context.browser.runtime.onMessage.removeListener([...listeners][0]);
  context.browser.runtime.onMessage.addListener(() => Promise.resolve(undefined));
  result = await dispatch({});
  assert.equal(result.keepOpen, true);
  assert.equal(result.calls, 1);
  assert.equal(result.response, undefined);

  for (const listener of [...listeners]) context.browser.runtime.onMessage.removeListener(listener);
  context.browser.runtime.onMessage.addListener(() => undefined);
  result = await dispatch({});
  assert.equal(result.keepOpen, undefined);
  assert.equal(result.calls, 0);
  context.browser.tabs.onRemoved.addListener((tabId, info) => ({ tabId, windowId: info.windowId }));
  assert.deepEqual([...tabRemovedListeners][0](12, { windowId: 4 }), { tabId: 12, windowId: 4 });
  process.stdout.write("Synthetic Chromium message adapter checks passed.\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
