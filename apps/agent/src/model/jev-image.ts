import { createHash, randomUUID } from 'node:crypto';
import type { Observation } from '../evidence/observation.js';
import { AgentFault } from '../http.js';

/** 与证据下载上限一致，解码前也限制字符串，避免额外分配无限内存。 */
const SOURCE_BYTES = 8 * 1024 * 1024;
/** 节点截图最长边与供应商像素上限不同；派生图不裁剪，必要时在右下补白。 */
const MAX_SIDE = 1568;
/** 280 平方同时满足供应商最小边长和最小总像素要求。 */
const MIN_SIDE = 280;
/** 限制原始图解码内存，不将压缩文件大小当作解码后的像素限制。 */
const SOURCE_PIXELS = 40_000_000;
/** 小于供应商 16 MiB 图片及 32 MiB 请求上限，给 JSON/base64 和结构留余量。 */
const IMAGE_BYTES = 8 * 1024 * 1024;
/** 整体传输预算包含 JSON 结构和 base64 膨胀。 */
export const JEV_REQUEST_BYTES = 24 * 1024 * 1024;
/** 暂无官方图片 token 公式；这是本地预留量，不作为实际计费或精确上限。 */
export const JEV_IMAGE_TOKEN_RESERVE = 8192;
/** 只接受内部证据下载生成的规范 PNG data URL，不接受远程地址。 */
const PNG_DATA = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

/** 模型图片与原始证据一一关联；尺寸变换用于把 Box 映射回视口。 */
export interface JevImage {
  /** 每次请求独立引用，防止页面文字意外触发替换。 */
  reference: string;
  /** 实际发送的规范 PNG，不写入模型调用展示正文。 */
  asset: { type: 'image'; format: 'png'; data_base64: string };
  /** 可存档的来源与变换信息，不含图片内容或下载凭据。 */
  metadata: {
    /** 未修改的截图证据身份。 */
    artifactId: string;
    /** 原图所属的当前观察。 */
    observationId: string;
    /** 与证据登记一致的原图摘要。 */
    sourceSha256: string;
    /** 实际发给模型的派生 PNG 摘要。 */
    sha256: string;
    /** 原始截图的像素宽度，可能包含设备像素比例。 */
    originalWidth: number;
    /** 原始截图的像素高度。 */
    originalHeight: number;
    /** 包含补白的模型图片宽度。 */
    width: number;
    /** 包含补白的模型图片高度。 */
    height: number;
    /** 缩放后的有效内容宽度；内容原点固定在左上角。 */
    contentWidth: number;
    /** 缩放后的有效内容高度，超出部分不能作为点击位置。 */
    contentHeight: number;
  };
}

/** 重新核实来源、完整解码并缩放图片；绝不改变原始证据及其摘要。 */
export async function prepareJevImage(
  image: string,
  page: Observation,
): Promise<JevImage> {
  if (image.length > (SOURCE_BYTES * 4) / 3 + 64)
    throw new AgentFault('JEV_IMAGE_INVALID', '截图超过模型预处理上限');
  const match = PNG_DATA.exec(image);
  if (!match)
    throw new AgentFault('JEV_IMAGE_INVALID', '截图不是规范 PNG 输入');
  const source = Buffer.from(match[1]!, 'base64');
  if (source.toString('base64') !== match[1] || source.length > SOURCE_BYTES)
    throw new AgentFault('JEV_IMAGE_INVALID', '截图编码或大小不合法');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const ref = page.artifactRefs.find(
    (r) => r.kind === 'SCREENSHOT' && r.sha256 === sourceSha256,
  );
  if (!ref) throw new AgentFault('EVIDENCE_MISMATCH', '截图不属于当前观察');
  try {
    // 纯文本部署不加载原生图片库；仅启用图片输入的 worker 需要对应平台的依赖。
    const { default: sharp } = await import('sharp');
    // 限制解码像素总量；节点正常视口远小于此上限，异常图片不会无限占用内存。
    const decoder = sharp(source, {
      limitInputPixels: SOURCE_PIXELS,
      failOn: 'warning',
    });
    const info = await decoder.metadata();
    if (
      info.format !== 'png' ||
      !info.width ||
      !info.height ||
      (info.pages ?? 1) !== 1
    )
      throw new Error('invalid screenshot');
    const scale = Math.min(1, MAX_SIDE / Math.max(info.width, info.height));
    const contentWidth = Math.max(1, Math.round(info.width * scale));
    const contentHeight = Math.max(1, Math.round(info.height * scale));
    const width = Math.max(MIN_SIDE, contentWidth);
    const height = Math.max(MIN_SIDE, contentHeight);
    const data = await decoder
      .resize(contentWidth, contentHeight, { fit: 'fill' })
      .extend({
        top: 0,
        left: 0,
        right: width - contentWidth,
        bottom: height - contentHeight,
        background: '#ffffff',
      })
      .png()
      .toBuffer();
    if (data.length > IMAGE_BYTES) throw new Error('image too large');
    return {
      reference: randomUUID(),
      asset: {
        type: 'image',
        format: 'png',
        data_base64: data.toString('base64'),
      },
      metadata: {
        artifactId: ref.artifactId,
        observationId: page.observationId,
        sourceSha256,
        sha256: createHash('sha256').update(data).digest('hex'),
        originalWidth: info.width,
        originalHeight: info.height,
        width,
        height,
        contentWidth,
        contentHeight,
      },
    };
  } catch {
    throw new AgentFault('JEV_IMAGE_INVALID', '截图无法解码或不符合图片限制');
  }
}
