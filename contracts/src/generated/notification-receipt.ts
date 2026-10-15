/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface NotificationReceipt {
  eventId: string;
  receiptId: string;
  status: 'accepted' | 'retrying' | 'delivered' | 'unknown' | 'failed' | 'superseded';
  attempts?: number;
  nextAttemptAt?: string | null;
  error?: string | null;
  messageRef?: string | null;
}
