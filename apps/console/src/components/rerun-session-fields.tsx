import type { SessionRequest } from '@proofrun/contracts';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { SelectField, SelectItem } from './select-field';

/** 重跑表单只收集非敏感身份选择，不接收 Cookie、密码或服务端凭据。 */
export interface RerunSessionDraft {
  /** 沿用来源或明确替换新运行的身份类型。 */
  mode: 'inherit' | SessionRequest['mode'];
  /** DevPass 平台以及可选的池或指定账号。 */
  platform: string;
  /** 可限定账号池；与账号 ID 至少填写一项。 */
  poolId: string;
  /** 指定账号时只提交非敏感账号标识。 */
  accountId: string;
  /** 每行一项登录后必须出现的文本，编译为明确的身份核验条件。 */
  checks: string;
}

/** 默认沿用来源；旧身份必须由用户主动选择新的会话方式。 */
export const EMPTY_RERUN_SESSION: RerunSessionDraft = {
  mode: 'inherit',
  platform: '',
  poolId: '',
  accountId: '',
  checks: '',
};

/** 在提交前验证最小选择条件，完整协议与业务冲突仍由服务端检查。 */
export function rerunSession(
  draft: RerunSessionDraft,
): SessionRequest | undefined {
  if (draft.mode === 'inherit') return undefined;
  if (draft.mode !== 'external') return { mode: draft.mode };
  const platform = draft.platform.trim();
  const poolId = draft.poolId.trim();
  const accountId = draft.accountId.trim();
  const checks = draft.checks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!platform || (!poolId && !accountId) || !checks.length)
    throw new Error(
      'DevPass 需要平台、账号池或账号 ID，以及至少一项身份核验文本。',
    );
  if (checks.length > 32) throw new Error('身份核验文本最多 32 项。');
  return {
    mode: 'external',
    external: {
      provider: 'devpass',
      platform,
      ...(accountId
        ? { accountId, ...(poolId ? { poolId } : {}) }
        : { poolId }),
    },
    requirements: checks.map((value, index) => ({
      id: `rerun-identity-${index + 1}`,
      description: value,
      method: 'text',
      value,
    })),
  };
}

/** 同一请求的各 case 独立配置，避免将登录任务和访客任务统一改成一种身份。 */
export function RerunSessionFields({
  value,
  change,
  disabled,
}: {
  value: RerunSessionDraft;
  change: (value: RerunSessionDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="form-grid">
      <label>
        会话身份
        <SelectField
          label="会话身份"
          value={value.mode}
          disabled={disabled}
          onValueChange={(mode) =>
            change({ ...value, mode: mode as RerunSessionDraft['mode'] })
          }
        >
          <SelectItem value="inherit">沿用原配置</SelectItem>
          <SelectItem value="guest">访客（未登录）</SelectItem>
          <SelectItem value="manual">当前会话人工登录</SelectItem>
          <SelectItem value="external">DevPass 外部账号</SelectItem>
        </SelectField>
      </label>
      {value.mode === 'manual' && (
        <p>新运行允许人工登录；登录态仅用于当前临时会话。</p>
      )}
      {value.mode === 'external' && (
        <>
          <label>
            DevPass 平台
            <Input
              value={value.platform}
              disabled={disabled}
              onChange={(e) => change({ ...value, platform: e.target.value })}
            />
          </label>
          <label>
            账号池 ID
            <Input
              value={value.poolId}
              disabled={disabled}
              onChange={(e) => change({ ...value, poolId: e.target.value })}
            />
          </label>
          <label>
            账号 ID（可选）
            <Input
              value={value.accountId}
              disabled={disabled}
              onChange={(e) => change({ ...value, accountId: e.target.value })}
            />
          </label>
          <label>
            身份核验文本（每行一项）
            <Textarea
              value={value.checks}
              disabled={disabled}
              onChange={(e) => change({ ...value, checks: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  );
}
