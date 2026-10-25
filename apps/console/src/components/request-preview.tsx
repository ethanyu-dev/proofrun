import type { RequestResultV2 } from '@proofrun/contracts';
import type { ReactNode } from 'react';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { CaseVerificationProgress } from './case-verification-progress';
import { RequestCaseLive } from './request-case-live';

/** 列表直接读取并展示全部 case，翻页时跟随父列表暂停自动刷新。 */
export function RequestPreview({
  api,
  id,
  poll = true,
  reports = false,
  renderHeader,
}: {
  api: ApiClient;
  id: string;
  poll?: boolean;
  reports?: boolean;
  /** 标题区与 case 行共享同一次读取，避免移动状态后出现两份数据快照。 */
  renderHeader?: (value: RequestResultV2 | undefined) => ReactNode;
}) {
  const resource = useResource<RequestResultV2>(
    api,
    `/v2/requests/${encodeURIComponent(id)}`,
    poll,
  );
  return (
    <>
      {renderHeader?.(resource.data)}
      <div className="request-preview-members">
        <ErrorNotice message={resource.error} />
        {!resource.data && resource.loading && <p>正在读取 case…</p>}
        {resource.data && (
          <RequestCasePreview value={resource.data} reports={reports} />
        )}
      </div>
    </>
  );
}

/** case 使用单行摘要，悬停仅补全标题，列表不暴露内部标识。 */
export function RequestCasePreview({
  value,
  reports = false,
}: {
  value: RequestResultV2;
  reports?: boolean;
}) {
  return (
    <>
      {value.cases.map((member, index) => (
        <section className="request-preview-member" key={member.caseId}>
          <div className="request-member-heading">
            <span className="request-index">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="request-member-title">
              <a
                href={`#/${reports ? 'request-reports' : 'requests'}/${encodeURIComponent(value.requestId)}`}
                title={member.title}
              >
                {member.title}
              </a>
              <RequestCaseLive member={member} requestId={value.requestId} />
            </div>
          </div>
          <CaseVerificationProgress member={member} />
        </section>
      ))}
    </>
  );
}
