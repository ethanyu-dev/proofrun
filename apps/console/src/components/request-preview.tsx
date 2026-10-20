import type { RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { CaseVerificationProgress } from './case-verification-progress';

/** 列表直接读取并展示全部 case，翻页时跟随父列表暂停自动刷新。 */
export function RequestPreview({
  api,
  id,
  poll = true,
  reports = false,
}: {
  api: ApiClient;
  id: string;
  poll?: boolean;
  reports?: boolean;
}) {
  const resource = useResource<RequestResultV2>(
    api,
    `/v2/requests/${encodeURIComponent(id)}`,
    poll,
  );
  return (
    <div className="request-preview-members">
      <ErrorNotice message={resource.error} />
      {!resource.data && resource.loading && <p>正在读取 case…</p>}
      {resource.data && (
        <RequestCasePreview value={resource.data} reports={reports} />
      )}
    </div>
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
            <div>
              <a
                href={`#/${reports ? 'request-reports' : 'requests'}/${encodeURIComponent(value.requestId)}`}
                title={member.title}
              >
                {member.title}
              </a>
            </div>
          </div>
          <CaseVerificationProgress member={member} />
        </section>
      ))}
    </>
  );
}
