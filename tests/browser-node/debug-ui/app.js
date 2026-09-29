// 页面只保留当前观察身份；动作使用刚获得的 target，避免复用过期 ref。
const state = { active: false, busy: false, observation: null };
const elements = Object.fromEntries(
  [
    'start',
    'close',
    'status',
    'url',
    'navigate',
    'observe',
    'screenshot',
    'target',
    'click',
    'input-value',
    'fill',
    'page-meta',
    'snapshot',
    'screenshot-path',
    'preview',
    'debug-log',
    'clear-log',
  ].map((id) => [id, document.getElementById(id)]),
);
// 内置页面提供可重复的输入和按钮变化，启动后无需依赖外部网站。
elements.url.value = `${location.origin}/fixture`;

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function updateControls() {
  elements.start.disabled = state.busy;
  elements.close.disabled = state.busy || !state.active;
  for (const id of ['navigate', 'observe', 'screenshot']) {
    elements[id].disabled = state.busy || !state.active;
  }
  const hasTarget = Boolean(
    state.observation?.observationId && elements.target.value,
  );
  elements.target.disabled =
    state.busy || !state.active || !state.observation?.targets?.length;
  elements.click.disabled = state.busy || !hasTarget;
  elements.fill.disabled = state.busy || !hasTarget;
}

function appendEvents(events = []) {
  for (const event of events) {
    const item = document.createElement('details');
    item.open = true;
    const title = document.createElement('summary');
    title.textContent = `${new Date().toLocaleTimeString()} ${event.direction}`;
    const body = document.createElement('pre');
    body.textContent = JSON.stringify(event.payload, null, 2);
    item.append(title, body);
    elements['debug-log'].prepend(item);
  }
}

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  appendEvents(data.events);
  return data;
}

function clearObservation() {
  state.observation = null;
  elements.target.replaceChildren(new Option('先观察页面', ''));
  elements['page-meta'].textContent = '暂无观察结果';
  elements.snapshot.textContent = '启动会话后，输入 URL 并点击“跳转并查看”。';
  updateControls();
}

function showObservation(observation) {
  state.observation = observation;
  elements['page-meta'].textContent =
    `${observation.title || '(无标题)'} · ${observation.url || ''} · observationId: ${observation.observationId} · 非原子快照`;
  elements.snapshot.textContent = observation.text || '(快照为空)';
  const previous = elements.target.value;
  elements.target.replaceChildren(new Option('选择 ref / target', ''));
  for (const item of observation.targets || []) {
    const label = `${item.target} · ${item.role || 'unknown'} · ${item.name || '(无名称)'}`;
    elements.target.add(new Option(label, item.target));
  }
  if (
    [...elements.target.options].some((option) => option.value === previous)
  ) {
    elements.target.value = previous;
  }
  if (observation.localScreenshot) {
    elements['screenshot-path'].textContent = observation.localScreenshot;
    elements.preview.src = `/api/screenshot?v=${Date.now()}`;
    elements.preview.hidden = false;
  }
  updateControls();
}

async function run(command) {
  const data = await request('/api/command', command);
  const result = data.events.at(-1)?.payload?.result;
  if (result?.Err) throw new Error(JSON.stringify(result.Err));
  if (command.type === 'browser.observe' && result?.Ok)
    showObservation(result.Ok);
  return result?.Ok;
}

async function observe(screenshot = true) {
  await run({ type: 'browser.observe', screenshot });
}

async function perform(action) {
  clearObservation();
  await run(action);
  await observe(true);
}

// 所有页面操作串行化，避免一次动作的结果被下一次观察误认。
async function withActivity(activity) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  setStatus('执行中…');
  try {
    await activity();
    setStatus(state.active ? '会话运行中' : '未启动');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    updateControls();
  }
}

elements.start.addEventListener('click', () =>
  withActivity(async () => {
    await request('/api/session/start');
    state.active = true;
    clearObservation();
    await observe(true);
  }),
);

elements.close.addEventListener('click', () =>
  withActivity(async () => {
    await request('/api/session/close');
    state.active = false;
    clearObservation();
    elements.preview.hidden = true;
    elements['screenshot-path'].textContent = '暂无截图';
  }),
);

elements.navigate.addEventListener('click', () =>
  withActivity(async () => {
    await perform({
      type: 'browser.act',
      action: 'navigate',
      target: elements.url.value.trim(),
    });
  }),
);

elements.observe.addEventListener('click', () =>
  withActivity(() => observe(false)),
);
elements.screenshot.addEventListener('click', () =>
  withActivity(() => observe(true)),
);

elements.click.addEventListener('click', () =>
  withActivity(async () => {
    const observationId = state.observation?.observationId;
    const target = elements.target.value;
    await perform({
      type: 'browser.act',
      action: 'click',
      target,
      observationId,
    });
  }),
);

elements.fill.addEventListener('click', () =>
  withActivity(async () => {
    const observationId = state.observation?.observationId;
    const target = elements.target.value;
    await perform({
      type: 'browser.act',
      action: 'fill',
      target,
      value: elements['input-value'].value,
      observationId,
    });
  }),
);

elements.target.addEventListener('change', updateControls);
elements['clear-log'].addEventListener('click', () =>
  elements['debug-log'].replaceChildren(),
);

const status = await fetch('/api/status').then((response) => response.json());
state.active = status.active;
if (status.observation) showObservation(status.observation);
if (status.hasScreenshot) {
  elements.preview.src = `/api/screenshot?v=${Date.now()}`;
  elements.preview.hidden = false;
}
setStatus(state.active ? '会话运行中' : '未启动');
updateControls();
