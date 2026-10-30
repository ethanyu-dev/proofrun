import { useState, type FormEvent } from 'react';
import type { AccessLogPage, AccessRecord } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  SelectField,
  SelectItem,
  ALL_FILTER_VALUE,
} from '../components/select-field';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  time,
} from '../components/ui';

/** 显示最终 HTTP 状态；登录的成功仅表示凭据验证通过。 */
function resultLabel(record: AccessRecord): string {
  if (record.kind === 'console_login') {
    if (record.statusCode >= 200 && record.statusCode < 300) return '登录成功';
    if (record.statusCode === 401) return '凭据无效';
    return '登录失败';
  }
  return record.statusCode >= 400 ? '请求失败' : '请求完成';
}

/** 管理员查询访问元数据；手动刷新避免页面轮询持续产生新的访问记录。 */
export function AccessLogsPage({ api }: { api: ApiClient }) {
  const [draft, setDraft] = useState('');
  const [ip, setIp] = useState('');
  const [kind, setKind] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams();
  if (ip) params.set('ip', ip);
  if (kind) params.set('kind', kind);
  if (cursors.at(-1)) params.set('before', cursors.at(-1)!);
  const resource = useResource<AccessLogPage>(
    api,
    `/v1/admin/access-logs?${params}`,
    false,
  );
  /** 新筛选回到第一页，不能复用其他 IP 或类型的游标。 */
  const search = (event: FormEvent) => {
    event.preventDefault();
    setIp(draft.trim());
    setCursors([null]);
  };
  return (
    <div>
      <PageHeader
        title="访问记录"
        description="查看最近访问的 IP、控制台登录验证和 HTTP 接口请求。"
      />
      <div className="toolbar">
        <form className="search-form" onSubmit={search}>
          <Input
            aria-label="来源 IP"
            placeholder="输入完整 IPv4 或 IPv6 地址"
            maxLength={45}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline">查询</Button>
        </form>
        <label>
          访问类型{' '}
          <SelectField
            label="访问类型"
            value={kind || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              setKind(value === ALL_FILTER_VALUE ? '' : value);
              setCursors([null]);
            }}
          >
            <SelectItem value={ALL_FILTER_VALUE}>全部访问</SelectItem>
            <SelectItem value="console_login">控制台登录</SelectItem>
            <SelectItem value="http">HTTP 请求</SelectItem>
          </SelectField>
        </label>
        <Button
          variant="outline"
          onClick={() => {
            setDraft('');
            setIp('');
            setKind('');
            setCursors([null]);
            resource.refresh();
          }}
        >
          重置
        </Button>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty
          title={resource.loading ? '正在读取访问记录…' : '访问记录读取失败'}
        />
      ) : resource.data.records.length === 0 ? (
        <Empty title="暂无匹配的访问记录">
          可调整 IP 或访问类型后重新查询。
        </Empty>
      ) : (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">访问时间</th>
                <th scope="col">来源 IP</th>
                <th scope="col">访问类型</th>
                <th scope="col">请求接口</th>
                <th scope="col">结果</th>
                <th scope="col">耗时</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.records.map((record) => (
                <tr key={record.id}>
                  <td>{time(record.at)}</td>
                  <td className="mono">{record.ip ?? '未知'}</td>
                  <td>
                    {record.kind === 'console_login'
                      ? '控制台登录'
                      : 'HTTP 请求'}
                  </td>
                  <td className="mono wrap">
                    {record.method} {record.route}
                  </td>
                  <td>
                    <span
                      className="status"
                      data-tone={
                        record.statusCode >= 400 ? 'danger' : 'success'
                      }
                    >
                      {record.statusCode} · {resultLabel(record)}
                    </span>
                  </td>
                  <td>{Math.round(record.durationMs)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span className="muted">第 {cursors.length} 页</span>
        <Button
          variant="outline"
          disabled={cursors.length === 1 || resource.loading}
          onClick={() => setCursors((items) => items.slice(0, -1))}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={!resource.data?.nextCursor || resource.loading}
          onClick={() =>
            setCursors((items) => [...items, resource.data!.nextCursor])
          }
        >
          下一页
        </Button>
      </div>
      <p className="muted note">
        保留最近 {resource.data?.retentionDays ?? 30}{' '}
        天的访问，从功能上线后开始记录。登录包含手动连接和自动恢复；接口显示路由模板。来源
        IP 按服务端代理配置解析。
      </p>
    </div>
  );
}
