(async function () {
  // 清理只作用于当前隔离 profile 的当前 origin；明确回读，不能以命令发出代替成功。
  const registrations =
    'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
  for (const registration of registrations) await registration.unregister();
  for (const name of 'caches' in globalThis ? await caches.keys() : [])
    await caches.delete(name);
  return {
    registrationsRemaining: ('serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : []
    ).length,
    cachesRemaining: ('caches' in globalThis ? await caches.keys() : []).length,
    origin: location.origin,
  };
})();
