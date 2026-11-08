/* Chromium compatibility layer for the Firefox WebExtension sources. */
(() => {
  const chromeApi = globalThis.chrome;
  const prior = globalThis.CraigZoneChromiumCompat;
  if (prior?.chromeApi === chromeApi && prior.browser === globalThis.browser) return;
  const eventCache = new WeakMap();
  const objectCache = new WeakMap();

  function wrapEvent(event) {
    if (!event || typeof event.addListener !== "function") return event;
    if (eventCache.has(event)) return eventCache.get(event);
    const listenerMap = new WeakMap();
    const wrapped = new Proxy(event, {
      get(target, property) {
        if (property === "addListener") return (listener, ...filters) => {
          const adapter = function (message, sender, sendResponse) {
            let result;
            try { result = listener(message, sender, sendResponse); }
            catch (error) { throw error; }
            if (result && typeof result.then === "function") {
              result.then((value) => sendResponse(value), () => sendResponse(undefined));
              return true;
            }
            if (result === true) return true;
            if (result !== undefined) sendResponse(result);
            return undefined;
          };
          listenerMap.set(listener, adapter);
          return target.addListener(adapter, ...filters);
        };
        if (property === "removeListener") return (listener) => target.removeListener(listenerMap.get(listener) || listener);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    eventCache.set(event, wrapped);
    return wrapped;
  }

  function wrapObject(object) {
    if (!object || (typeof object !== "object" && typeof object !== "function")) return object;
    if (objectCache.has(object)) return objectCache.get(object);
    const wrapped = new Proxy(object, {
      get(target, property) {
        if (target === chromeApi.runtime && property === "onMessage") return wrapEvent(Reflect.get(target, property, target));
        const value = Reflect.get(target, property, target);
        if (value && typeof value === "object") return wrapObject(value);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    objectCache.set(object, wrapped);
    return wrapped;
  }

  globalThis.browser = wrapObject(chromeApi);
  globalThis.CraigZoneChromium = {
    isTrustedPopupSender: (sender) => sender?.url === chromeApi.runtime.getURL("popup.html")
  };
  globalThis.CraigZoneChromiumCompat = { chromeApi, browser: globalThis.browser };
})();
