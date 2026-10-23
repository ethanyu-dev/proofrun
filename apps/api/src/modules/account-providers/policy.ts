/** 外部账号申请额外包含一次人工处理余量；人工处理仍受剩余租约硬期限约束。 */
export const ACCOUNT_HUMAN_MARGIN_MS = 300_000;
/** 提前停止使用，给浏览器关闭与交还预留时间。 */
export const ACCOUNT_CLOSE_MARGIN_MS = 30_000;
/** 当前 DevPass 协议不支持续租，单次最长两小时。 */
export const ACCOUNT_MAX_SECONDS = 7200;
