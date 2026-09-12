import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getProjectFileContent } from "./api";
import { useReadRequests } from "./readRequests";
import type { CodeSearchResult, ProjectFileContent } from "./types";


interface CodeViewerProps {
  projectId: number;
  result: CodeSearchResult;
  query: string;
  onClose: () => void;
}

// Mirrors repository_qa_service.MAX_EVIDENCE_CHARS. Python slices Unicode
// code points, not UTF-16 units; public snippets have no ellipsis or trimming.
const MAX_EVIDENCE_CHARS = 1_600;

function sourceEvidence(lines: string[], start: number, end: number): string {
  const characters: string[] = [];
  for (let index = start - 1; index < end && characters.length < MAX_EVIDENCE_CHARS; index += 1) {
    if (index > start - 1) characters.push("\n");
    for (const character of lines[index]) {
      if (characters.length === MAX_EVIDENCE_CHARS) break;
      characters.push(character);
    }
  }
  return characters.join("");
}

function validateSource(response: ProjectFileContent, result: CodeSearchResult): void {
  if (!response || response.file_id !== result.file_id || response.file_path !== result.file_path) {
    throw new Error("引用文件与当前索引不一致，可能已重新分析或同步仓库。请返回原功能重新定位源码。");
  }
  if (!Array.isArray(response.lines) || response.lines.some((line) => typeof line !== "string")) {
    throw new Error("源文件内容格式异常，请重新读取。");
  }
  const evidence = result.expected_evidence;
  if (evidence === undefined) return;
  if (!evidence || !Number.isSafeInteger(evidence.start_line) || !Number.isSafeInteger(evidence.end_line)
    || evidence.start_line < 1 || evidence.end_line < evidence.start_line || evidence.end_line > response.lines.length
    || typeof evidence.snippet !== "string"
    || sourceEvidence(response.lines, evidence.start_line, evidence.end_line) !== evidence.snippet) {
    throw new Error("问答引用与当前源码不一致，原行号或证据内容可能已改变。请重新提问以获取当前版本的引用。");
  }
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
  const sourceKey = JSON.stringify([projectId, result.file_id, result.file_path,
    result.expected_evidence?.start_line ?? null, result.expected_evidence?.end_line ?? null,
    result.expected_evidence?.snippet ?? null]);
  const [source, setSource] = useState<{
    key: string;
    content: ProjectFileContent | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const currentSource = source?.key === sourceKey ? source : null;
  const content = currentSource?.content ?? null;
  const loading = currentSource?.loading ?? true;
  const error = currentSource?.error ?? null;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "path" | "code" | "error">("idle");
  const copyAttemptRef = useRef(0);
  const copyResetTimerRef = useRef<number | null>(null);
  const highlightedLineRef = useRef<HTMLDivElement>(null);
  const reads = useReadRequests();
  const pattern = useMemo(() => queryPattern(query), [query]);

  const cancelCopyFeedback = useCallback(() => {
    copyAttemptRef.current += 1;
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const request = reads.begin("source");
    cancelCopyFeedback();
    setCopyStatus("idle");
    setSource({ key: sourceKey, content: null, loading: true, error: null });
    void getProjectFileContent(projectId, result.file_id, request.signal)
      .then((response) => {
        if (request.isCurrent()) {
          validateSource(response, result);
          setSource({ key: sourceKey, content: response, loading: false, error: null });
        }
      })
      .catch((requestError: unknown) => {
        if (request.isCurrent()) {
          setSource({
            key: sourceKey,
            content: null,
            loading: false,
            error: requestError instanceof Error ? requestError.message : "无法读取源文件",
          });
        }
      })
      .finally(request.finish);
    return () => {
      reads.cancel("source");
      cancelCopyFeedback();
    };
  }, [projectId, result.file_id, sourceKey, loadAttempt, reads, cancelCopyFeedback]);

  const handleClose = useCallback(() => {
    reads.cancel("source");
    cancelCopyFeedback();
    onClose();
  }, [reads, cancelCopyFeedback, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  useEffect(() => {
    if (!content || !highlightedLineRef.current) return;
    highlightedLineRef.current.scrollIntoView?.({ block: "center" });
  }, [content, result.snippet_start_line, result.snippet_end_line]);

  async function copyText(value: string, status: "path" | "code") {
    cancelCopyFeedback();
    const attempt = copyAttemptRef.current;
    setCopyStatus("idle");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      if (attempt !== copyAttemptRef.current) return;
      setCopyStatus(status);
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null;
        if (attempt === copyAttemptRef.current) setCopyStatus("idle");
      }, 1_500);
    } catch {
      if (attempt === copyAttemptRef.current) setCopyStatus("error");
    }
  }

  return (
    <div className="code-viewer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && handleClose()}>
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
            <button type="button" className="code-viewer-close" aria-label="关闭代码查看器" onClick={handleClose}>×</button>
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
