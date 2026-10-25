import { useState } from 'react';
import type { SessionRequest } from '@proofrun/contracts';
import { Modal } from './modal';
import { Button } from './ui/button';
import { ErrorNotice } from './ui';
import {
  EMPTY_RERUN_SESSION,
  RerunSessionFields,
  rerunSession,
  type RerunSessionDraft,
} from './rerun-session-fields';

/** 弹窗保留每个 case 的输入；响应不确定时冻结选择，重试必须沿用整份请求。 */
export function RerunDialog({
  open,
  items,
  pending,
  locked,
  error,
  close,
  submit,
}: {
  open: boolean;
  items: { id: string; title: string }[];
  pending: boolean;
  locked: boolean;
  error: string | undefined;
  close: () => void;
  submit: (sessions: Record<string, SessionRequest | undefined>) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, RerunSessionDraft>>({});
  const [validation, setValidation] = useState<string>();
  if (!open) return null;
  return (
    <Modal
      title="配置重跑会话"
      description="新运行保留原步骤和历史记录。旧本地身份需重新选择；各 case 可使用不同会话身份。"
      busy={pending}
      close={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setValidation(undefined);
          try {
            submit(
              Object.fromEntries(
                items.map((item) => [
                  item.id,
                  rerunSession(drafts[item.id] ?? EMPTY_RERUN_SESSION),
                ]),
              ),
            );
          } catch (failure) {
            setValidation(
              failure instanceof Error ? failure.message : '会话配置无效',
            );
          }
        }}
      >
        <div className="rerun-session-list">
          {items.map((item) => (
            <fieldset key={item.id} disabled={pending || locked}>
              <legend>{item.title}</legend>
              <RerunSessionFields
                value={drafts[item.id] ?? EMPTY_RERUN_SESSION}
                disabled={pending || locked}
                change={(value) =>
                  setDrafts((previous) => ({ ...previous, [item.id]: value }))
                }
              />
            </fieldset>
          ))}
        </div>
        {locked && !pending && (
          <p>上次提交结果未确认，重试将沿用相同身份配置和运行 ID。</p>
        )}
        <ErrorNotice message={validation ?? error} />
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={close}
        >
          取消
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? '正在提交重跑…' : locked ? '重试提交' : '提交重跑'}
        </Button>
      </form>
    </Modal>
  );
}
