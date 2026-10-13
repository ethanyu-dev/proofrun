import type { StepResult } from '@proofrun/contracts';

/** 展示真实面板读取进度，避免将部分读取误当成整项验收通过。 */
export function StepReadings({
  readings,
}: {
  readings?: StepResult['readings'];
}) {
  if (!readings?.length) return null;
  return (
    <details>
      <summary>
        子项读取进度（
        {readings.filter((item) => item.status === 'recorded').length}/
        {readings.length} 已记录，不代表验收通过）
      </summary>
      <ul>
        {readings.map((item) => (
          <li key={item.id}>
            {item.heading ? `${item.heading} · ` : ''}
            {item.name}：
            {
              {
                pending: '尚未取得内容',
                observed: '已观察，尚未记录读取',
                recorded: '已记录读取证据',
              }[item.status]
            }
            {item.quote && <blockquote>{item.quote}</blockquote>}
          </li>
        ))}
      </ul>
    </details>
  );
}
