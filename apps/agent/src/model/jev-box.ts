import type { Observation } from '../evidence/observation.js';
import type { JevImage } from './jev-image.js';
import { AgentFault } from '../http.js';

/** 实验执行门槛，尚未经过真实站点评估；不是供应商推荐值或正确率保证。 */
const MIN_CONFIDENCE = 0.9;
/** 只使用已升级节点的画面复核能力，旧节点不能仅凭视口一致开放 Box。 */
export function supportsJevBox(page: Observation): boolean {
  const v = page.viewport as Record<string, unknown> | undefined;
  return (
    !!v &&
    v.visualRecheck === 'sha256' &&
    typeof v.width === 'number' &&
    Number.isFinite(v.width) &&
    v.width > 0 &&
    typeof v.height === 'number' &&
    Number.isFinite(v.height) &&
    v.height > 0
  );
}

/** 验证存在性、唯一性及完整边框，再把无裁剪、右下补白图片坐标映射到 CSS 视口。 */
export function jevBoxPoint(
  answers: Record<string, unknown> | undefined,
  image: JevImage,
  page: Observation,
): { x: number; y: number } {
  const invalid = () =>
    new AgentFault(
      'INVALID_MODEL_DECISION',
      '视觉目标不存在、不唯一、置信度不足或坐标不合法',
    );
  const exists = answers?.exists as { noul?: number } | undefined;
  const unique = answers?.unique as
    | {
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      }
    | undefined;
  const answer = answers?.target as
    { confidence?: number; box?: Record<string, number> } | undefined;
  const confident = (n: unknown): n is number =>
    typeof n === 'number' &&
    Number.isFinite(n) &&
    n >= MIN_CONFIDENCE &&
    n <= 1;
  const p = unique?.probabilities;
  const b = answer?.box;
  if (
    !supportsJevBox(page) ||
    !confident(exists?.noul) ||
    unique?.choice !== 'one' ||
    !confident(unique.confidence) ||
    !p ||
    Object.keys(p).length !== 3 ||
    !['none', 'one', 'several'].every(
      (k) => Number.isFinite(p[k]) && p[k]! >= 0 && p[k]! <= 1,
    ) ||
    Math.abs(p.none! + p.one! + p.several! - 1) > 0.02 ||
    !confident(p.one) ||
    !confident(answer?.confidence) ||
    !b ||
    !['left', 'right', 'top', 'bottom'].every(
      (k) => Number.isFinite(b[k]) && b[k]! >= 0 && b[k]! <= 1,
    ) ||
    b.left! >= b.right! ||
    b.top! >= b.bottom!
  )
    throw invalid();
  const m = image.metadata;
  const viewport = page.viewport as { width: number; height: number };
  // 原图必须是整个视口等比例截图；未知裁剪或宽高比例异常不猜测变换。
  if (
    Math.abs(
      m.originalWidth / m.originalHeight - viewport.width / viewport.height,
    ) > 0.01 ||
    b.right! * m.width > m.contentWidth ||
    b.bottom! * m.height > m.contentHeight
  )
    throw invalid();
  const x =
    ((((b.left! + b.right!) / 2) * m.width) / m.contentWidth) * viewport.width;
  const y =
    ((((b.top! + b.bottom!) / 2) * m.height) / m.contentHeight) *
    viewport.height;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= viewport.width ||
    y >= viewport.height
  )
    throw invalid();
  return { x, y };
}
