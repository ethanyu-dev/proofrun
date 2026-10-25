import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import type { RequestResultV2 } from '@proofrun/contracts';

/** 下载绑定页面当前服务端快照，刷新后重新生成并回收旧下载地址。 */
export function RequestExport({ value }: { value: RequestResultV2 }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [value]);
  return url ? (
    <Button asChild variant="outline">
      <a
        className="button button-secondary"
        href={url}
        download={`${value.requestId}-${value.reportPhase === 'FINAL' ? 'final' : 'partial'}-report.json`}
      >
        导出{value.reportPhase === 'FINAL' ? '最终' : '部分'}报告 JSON
      </a>
    </Button>
  ) : null;
}
