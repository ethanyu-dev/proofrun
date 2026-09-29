import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 报告来自模型及外部页面，仅渲染 Markdown；不执行内嵌 HTML，也不加载远程图片。 */
export function ReportSummary({ text }: { text: string }) {
  // 部分模型将整张表格的换行再次转义；只在单行表格文本中恢复显示，存档原文保持不变。
  const markdown =
    !text.includes('\n') && /\\n\|/.test(text)
      ? text.replace(/\\n/g, '\n')
      : text;
  return (
    <div className="report-summary">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={['img']}
        components={{
          table: ({ children }) => (
            <div className="report-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
