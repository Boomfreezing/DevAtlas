import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectFileTreeNode } from "../types";
import { useTreeWindowing } from "./treeRenderBudget";

const ROWS_PER_PAGE = 200;
const WINDOW_AFTER = 600;
const ESTIMATED_ROW_HEIGHT = 44;

type Props = {
  items: ProjectFileTreeNode[];
  renderFile: (file: ProjectFileTreeNode, index: number) => ReactNode;
};

// Only file rows are windowed. Directories keep their component identity and
// expanded descendants when a distant file page leaves the viewport.
export default function FileTreeFilePages({ items, renderFile }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [focusedPage, setFocusedPage] = useState<number | null>(null);
  const [selectedPages, setSelectedPages] = useState<[number, number] | null>(null);
  const treeWindowed = useTreeWindowing();
  const windowed = items.length > 0 && (items.length > WINDOW_AFTER || treeWindowed) && typeof IntersectionObserver !== "undefined"
    && typeof ResizeObserver !== "undefined";
  useEffect(() => {
    if (!windowed) { setSelectedPages(null); return; }
    function updateSelection() {
      const selection = document.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      const selected = range && container.current ? [...container.current.querySelectorAll<HTMLElement>("[data-file-page]")]
        .filter((page) => range.intersectsNode(page)).map((page) => Number(page.dataset.filePage)) : [];
      const next: [number, number] | null = selected.length ? [selected[0], selected[selected.length - 1]] : null;
      setSelectedPages((previous) => previous?.[0] === next?.[0] && previous?.[1] === next?.[1] ? previous : next);
    }
    updateSelection();
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [windowed]);
  const pages = [];
  for (let start = 0; start < items.length; start += ROWS_PER_PAGE) {
    const index = start / ROWS_PER_PAGE;
    pages.push(<FilePage key={index} items={items} start={start} renderFile={renderFile}
      windowed={windowed} pinned={(focusedPage !== null && Math.abs(focusedPage - index) <= 1)
        || (selectedPages !== null && index >= selectedPages[0] && index <= selectedPages[1])} />);
  }
  return <div ref={container} className="file-tree-file-pages" onFocusCapture={(event) => {
    const page = (event.target as HTMLElement).closest<HTMLElement>("[data-file-page]");
    if (page) setFocusedPage(Number(page.dataset.filePage));
  }} onBlurCapture={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      setFocusedPage(null);
    }
  }}>{pages}</div>;
}

const FilePage = memo(function FilePage({ items, start, renderFile, windowed, pinned }: Props & {
  start: number; windowed: boolean; pinned: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(start === 0);
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT);
  const count = Math.min(ROWS_PER_PAGE, items.length - start);
  const visible = !windowed || nearViewport || pinned;

  useEffect(() => {
    const page = element.current;
    if (!page || !windowed) return;
    let active = true;
    // The viewport root also respects ancestor overflow clipping. It therefore
    // works for both desktop list scrolling and compact document scrolling.
    const observer = new IntersectionObserver(([entry]) => {
      if (active && entry) setNearViewport(entry.isIntersecting);
    }, { root: null, rootMargin: "400px 0px", threshold: 0 });
    observer.observe(page);
    return () => { active = false; observer.disconnect(); };
  }, [windowed]);

  useEffect(() => {
    const page = element.current;
    if (!page || !visible || typeof ResizeObserver === "undefined") return;
    let active = true;
    const observer = new ResizeObserver(([entry]) => {
      if (!active || !entry || !count || entry.contentRect.height <= 0) return;
      // contentRect uses layout CSS pixels: boundingClientRect includes the
      // application's body zoom and would double-scale spacer heights.
      const measured = entry.contentRect.height / count;
      setRowHeight((previous) => Math.abs(previous - measured) > 0.1 ? measured : previous);
    });
    observer.observe(page);
    return () => { active = false; observer.disconnect(); };
  }, [visible, count]);

  return <div ref={element} className="file-tree-file-page" data-file-page={start / ROWS_PER_PAGE}
    data-windowed={windowed ? "true" : undefined} data-materialized={visible ? "true" : "false"}
    style={visible ? undefined : { height: count * rowHeight }} aria-hidden={visible ? undefined : true}>
    {visible && items.slice(start, start + count).map((file, index) => renderFile(file, start + index))}
  </div>;
});
