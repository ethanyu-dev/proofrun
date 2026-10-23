import type { ReactNode } from 'react';

/** 统一表单标签和可访问关联；children 不拼接 HTML。 */
export function IdentityField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="identity-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
