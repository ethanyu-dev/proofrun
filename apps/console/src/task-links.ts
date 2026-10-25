/** 只保留合法的来源请求身份，避免任务与报告互跳时丢失返回路径。 */
export function sourceRequestId(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get(
    'request',
  );
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined;
}

/** 链接始终指向具体运行；来源请求仅用于导航，不替换任务身份。 */
export function taskHref(
  view: 'tasks' | 'reports',
  id: string,
  requestId = sourceRequestId(),
): string {
  const path = `#/${view}/${encodeURIComponent(id)}`;
  return requestId ? `${path}?request=${encodeURIComponent(requestId)}` : path;
}
