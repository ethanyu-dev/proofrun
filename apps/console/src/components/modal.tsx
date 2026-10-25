import { useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/** 受控弹窗统一关闭、忙碌保护与焦点归还，适用于由列表按钮条件挂载的弹窗。 */
export function Modal({
  title,
  description,
  close,
  busy = false,
  className,
  children,
}: {
  /** 标题同时作为弹窗的可访问名称。 */
  title: string;
  /** 提示操作影响或内容归属，不承载请求错误。 */
  description?: ReactNode;
  /** 由业务层卸载弹窗，不在组件内发起或重试请求。 */
  close: () => void;
  /** 请求进行中阻止关闭，避免隐藏尚未确认的操作结果。 */
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [trigger] = useState(() =>
    typeof document === 'undefined'
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        className={className}
        showCloseButton={!busy}
        {...(!description ? { 'aria-describedby': undefined } : {})}
        onOpenAutoFocus={(event) => {
          const cancel =
            event.currentTarget instanceof HTMLElement
              ? event.currentTarget.querySelector<HTMLElement>(
                  '[data-dialog-cancel]',
                )
              : null;
          if (cancel) {
            event.preventDefault();
            cancel.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger?.isConnected) trigger.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
