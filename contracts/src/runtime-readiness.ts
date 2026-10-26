/** 只识别明确等待激活的准备指令；注销、否定和普通注册状态检查不提升为激活要求。 */
const WAIT_FOR_ACTIVE =
  /等待\s*Service\s*Worker[^。；\n]{0,32}(?:激活|activated)|wait\s+for\s+(?:the\s+)?service\s*worker\s+to\s+(?:be\s+)?activat/iu;
const NEGATED = /不(?:要|需|必|再)?\s*等待|注销|unregister|do\s+not\s+wait/iu;

/** 原始准备描述仍是唯一来源；这里只增加该明确要求的固定证据门禁。 */
export function requiresActiveServiceWorker(step: {
  type?: string;
  description: string;
}): boolean {
  return (
    step.type === 'setup' &&
    WAIT_FOR_ACTIVE.test(step.description) &&
    !NEGATED.test(step.description)
  );
}

/** 必须存在控制当前步骤 URL 的已激活注册；页面加载、installing 或其他 origin 注册均不能通过。 */
export function activeServiceWorkerObserved(
  url: string,
  runtime: unknown,
): boolean {
  if (!runtime || typeof runtime !== 'object') return false;
  const value = runtime as {
    status?: string;
    origin?: string;
    serviceWorker?: {
      registrations?: Array<{ scope?: string; active?: { state?: string } }>;
    };
  };
  try {
    const target = new URL(url);
    return (
      value.status === 'observed' &&
      value.origin === target.origin &&
      Array.isArray(value.serviceWorker?.registrations) &&
      value.serviceWorker.registrations.some((registration) => {
        if (registration.active?.state !== 'activated' || !registration.scope)
          return false;
        const scope = new URL(registration.scope);
        return (
          scope.origin === target.origin && target.href.startsWith(scope.href)
        );
      })
    );
  } catch {
    return false;
  }
}
