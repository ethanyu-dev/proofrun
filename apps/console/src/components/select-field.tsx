import type { ComponentProps, ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

/** 空筛选的界面值，与 API 使用的空字符串分开，避免与占位符冲突。 */
export const ALL_FILTER_VALUE = '__all__';

/** 业务下拉框统一提供可访问名称；菜单经 Portal 展示，避免被表格或面板裁切。 */
export function SelectField({
  label,
  children,
  ...props
}: ComponentProps<typeof Select> & {
  /** 与可见字段标题一致的名称，用于屏幕阅读器和菜单触发器。 */
  label: string;
  /** 业务选项由调用方提供，组件不推断或更改协议值。 */
  children: ReactNode;
}) {
  return (
    <Select {...props}>
      <SelectTrigger aria-label={label} className="select-field">
        <SelectValue placeholder="请选择" />
      </SelectTrigger>
      <SelectContent position="popper" align="start" aria-label={label}>
        {children}
      </SelectContent>
    </Select>
  );
}
export { SelectItem };
