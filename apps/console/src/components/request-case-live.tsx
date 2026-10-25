import { displayedCaseArm, type RequestCase } from '../request-presentation';
import { Badge } from './ui/badge';

/** 标签跟随本行展示的执行状态；只提供观看入口，不在列表订阅视频流。 */
export function RequestCaseLive({
  member,
  requestId,
}: {
  member: RequestCase;
  requestId: string;
}) {
  const arm = displayedCaseArm(member);
  if (arm?.result.status !== 'RUNNING') return null;
  return (
    <Badge
      asChild
      variant="secondary"
      className="status case-live-link"
      data-tone="success"
    >
      <a
        href={`#/tasks/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(requestId)}`}
        aria-label={`Live：查看「${member.title}」实时流`}
        title="查看实时流"
      >
        Live
      </a>
    </Badge>
  );
}
