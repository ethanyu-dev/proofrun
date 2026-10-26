(async function () {
  // 固定只读探针仅查询当前 origin；有界等待不把超时误报为“未注册”。
  const LIMIT = 200;
  const safeURL = (raw) => {
    const u = new URL(raw, location.href);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.href;
  };
  const worker = (w) =>
    w ? { scriptURL: safeURL(w.scriptURL), state: w.state } : null;
  const read = async () => {
    const registrations =
      'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistrations()
        : null;
    return {
      status: 'observed',
      origin: location.origin,
      capturedAt: Date.now(),
      serviceWorker: {
        supported: registrations !== null,
        registrations: registrations?.slice(0, LIMIT).map((r) => ({
          scope: safeURL(r.scope),
          active: worker(r.active),
          waiting: worker(r.waiting),
          installing: worker(r.installing),
        })),
        controller: worker(navigator.serviceWorker?.controller),
        truncated: (registrations?.length ?? 0) > LIMIT,
      },
      cacheStorage: { supported: 'caches' in globalThis },
    };
  };
  return Promise.race([
    read().catch(() => ({
      status: 'unavailable',
      reason: 'RUNTIME_READ_FAILED',
    })),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({ status: 'unavailable', reason: 'RUNTIME_READ_TIMEOUT' }),
        1500,
      ),
    ),
  ]);
})();
