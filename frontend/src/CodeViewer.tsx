import { useEffect, useMemo, useRef, useState } from "react";

import { getProjectFileContent } from "./api";
import type { CodeSearchResult, ProjectFileContent } from "./types";


interface CodeViewerProps {
  projectId: number;
  result: CodeSearchResult;
  query: string;
  onClose: () => void;
}

function queryPattern(query: string): RegExp | null {
  const tokens = query.match(/[\p{L}\p{N}_$]+/gu) ?? [];
  const uniqueTokens = [...new Set(tokens.map((token) => token.toLowerCase()))]
    .sort((left, right) => right.length - left.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return uniqueTokens.length ? new RegExp(`(${uniqueTokens.join("|")})`, "gi") : null;
}

function HighlightedLine({ line, pattern }: { line: string; pattern: RegExp | null }) {
  if (!pattern) return <>{line || " "}</>;
  pattern.lastIndex = 0;
  const parts = line.split(pattern);
  return (
    <>
      {parts.map((part, index) => {
        pattern.lastIndex = 0;
        return pattern.test(part)
          ? <mark key={`${index}-${part}`}>{part}</mark>
          : <span key={`${index}-${part}`}>{part}</span>;
      })}
    </>
  );
}

export default function CodeViewer({ projectId, result, query, onClose }: CodeViewerProps) {
  const [content, setContent] = useState<ProjectFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "path" | "code" | "error">("idle");
  const highlightedLineRef = useRef<HTMLDivElement>(null);
  const pattern = useMemo(() => queryPattern(query), [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getProjectFileContent(projectId, result.file_id)
      .then((response) => {
        if (active) setContent(response);
      })
      .catch((requestError: unknown) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "无法读取源文件");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, result.file_id, loadAttempt]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!content || !highlightedLineRef.current) return;
    highlightedLineRef.current.scrollIntoView?.({ block: "center" });
  }, [content]);

  async function copyText(value: string, status: "path" | "code") {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setCopyStatus(status);
      window.setTimeout(() => setCopyStatus("idle"), 1_500);
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <div className="code-viewer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="code-viewer" role="dialog" aria-modal="true" aria-labelledby="code-viewer-title">
        <header className="code-viewer-heading">
          <div>
            <p className="eyebrow">SOURCE_VIEWER::READ_ONLY</p>
            <h2 id="code-viewer-title">{result.file_path}</h2>
            <span>
              {content?.language ?? "未识别语言"} · 匹配第 {result.snippet_start_line}–{result.snippet_end_line} 行
              {content ? ` · 共 ${content.total_lines} 行` : ""}
            </span>
          </div>
          <div className="code-viewer-actions">
            <button type="button" onClick={() => void copyText(result.file_path, "path")}>{copyStatus === "path" ? "已复制路径" : "复制路径"}</button>
            <button type="button" onClick={() => content && void copyText(content.lines.join("\n"), "code")} disabled={!content}>{copyStatus === "code" ? "已复制代码" : "复制代码"}</button>
            <button type="button" className="code-viewer-close" aria-label="关闭代码查看器" onClick={onClose}>×</button>
          </div>
        </header>

        {copyStatus === "error" && <div className="code-viewer-notice">浏览器未授予剪贴板权限，请手动选择并复制。</div>}
        {loading && <div className="code-viewer-state">正在读取源文件…</div>}
        {error && (
          <div className="code-viewer-state error" role="alert">
            <strong>无法打开源码</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重新读取</button>
          </div>
        )}
        {content && (
          <div className="code-viewer-code" role="region" aria-label={`${content.file_path} 源代码`}>
            {content.lines.map((line, index) => {
              const lineNumber = index + 1;
              const highlighted = lineNumber >= result.snippet_start_line && lineNumber <= result.snippet_end_line;
              return (
                <div
                  className={`code-viewer-line ${highlighted ? "highlighted" : ""}`}
                  key={lineNumber}
                  ref={lineNumber === result.snippet_start_line ? highlightedLineRef : undefined}
                >
                  <span className="code-viewer-line-number">{lineNumber}</span>
                  <code><HighlightedLine line={line} pattern={pattern} /></code>
                </div>
              );
            })}
            {!content.lines.length && <div className="code-viewer-state">这是一个空文件。</div>}
          </div>
        )}
      </section>
    </div>
  );
}
