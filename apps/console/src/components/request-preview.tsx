import { useState } from 'react';
import type { RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { RequestStatus as Status } from './request-status';

/** 只在主动展开时读取成员，不为列表上的每个请求预先发起详情查询。 */
export function RequestPreview({ api, id }: { api: ApiClient; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="request-preview"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>展开关联 case</summary>
      {open && <Members api={api} id={id} />}
    </details>
  );
}

/** 展开视图保留两组身份，完整验收与证据在请求详情中查看。 */
function Members({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<RequestResultV2>(
    api,
    `/v2/requests/${encodeURIComponent(id)}`,
  );
  return (
    <div className="request-preview-members">
      <ErrorNotice message={resource.error} />
      {!resource.data && resource.loading && <p>正在读取关联 case…</p>}
      {resource.data?.cases.map((member, index) => (
        <section className="request-preview-member" key={member.caseId}>
          <div className="request-member-heading">
            <span className="request-index">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div>
              <a href={`#/requests/${encodeURIComponent(id)}`}>
                {member.title}
              </a>
              <p className="mono muted request-id">{member.caseId}</p>
            </div>
          </div>
          <div className="request-arms">
            {member.arms.map((arm) => (
              <div className="request-preview-arm" key={arm.taskId}>
                <strong>
                  {arm.executionMode === 'llm' ? 'LLM' : 'JEV + LLM'}
                </strong>
                <Status value={arm.result.status} />
                {arm.result.reportStatus ? (
                  <Status value={arm.result.reportStatus} />
                ) : (
                  <span className="muted">尚无报告</span>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
