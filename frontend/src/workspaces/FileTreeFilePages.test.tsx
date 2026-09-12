// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectFileTreeNode } from "../types";
import FileTreeFilePages from "./FileTreeFilePages";
import { TreeRenderBudget, TreeRenderBudgetContext } from "./treeRenderBudget";

const items = Array.from({ length: 1000 }, (_, index): ProjectFileTreeNode => ({
  kind: "file", path: `src/file-${index}.ts`, name: `file-${index}.ts`, file_count: 1,
  id: index, extension: ".ts", language: "TypeScript", size_bytes: 40, line_count: 4,
}));
const renderFile = (file: ProjectFileTreeNode) => <button key={file.path}>{file.name}</button>;
type Observer = { target: Element; deliver: (entry: object) => void; disconnect: ReturnType<typeof vi.fn> };

function observers() {
  const intersections: Observer[] = [], sizes: Observer[] = [];
  for (const [name, list] of [["IntersectionObserver", intersections], ["ResizeObserver", sizes]] as const) {
    vi.stubGlobal(name, class {
      callback: (entry: object[]) => void;
      disconnect = vi.fn();
      constructor(callback: (entry: object[]) => void) { this.callback = callback; }
      observe(target: Element) {
        list.push({ target, disconnect: this.disconnect, deliver: (entry) => this.callback([entry]) });
      }
    });
  }
  const intersect = (page: number, visible: boolean) => act(() => {
    intersections.filter((observer) => observer.target.getAttribute("data-file-page") === String(page))
      .forEach((observer) => observer.deliver({ isIntersecting: visible }));
  });
  return { intersections, sizes, intersect };
}

afterEach(() => { cleanup(); document.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); });

it("renders every loaded row when browser observers are unavailable", () => {
  render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  expect(screen.getAllByRole("button")).toHaveLength(1000);
});

it("keeps small directories unwindowed and renders only the first page of a reopened large list", () => {
  const { intersections } = observers();
  const view = render(<FileTreeFilePages items={items.slice(0, 450)} renderFile={renderFile} />);
  expect(screen.getAllByRole("button")).toHaveLength(450);
  expect(intersections).toHaveLength(0);
  view.rerender(<FileTreeFilePages items={items} renderFile={renderFile} />);
  expect(screen.getAllByRole("button")).toHaveLength(200);
  expect(intersections).toHaveLength(5);
  expect(view.container.querySelector('[data-file-page="4"]')?.getAttribute("style")).toContain("8800px");
});

it("recycles distant pages and restores their files without creating API requests", () => {
  const { intersect } = observers();
  render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  intersect(0, false);
  intersect(4, true);
  expect(screen.queryByText("file-0.ts")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(200);
  expect(screen.getByText("file-999.ts")).toBeTruthy();
  intersect(4, false);
  intersect(0, true);
  expect(screen.getByText("file-0.ts")).toBeTruthy();
  expect(screen.queryByText("file-999.ts")).toBeNull();
});

it("preserves layout-pixel height rather than multiplying CSS zoom into the spacer", () => {
  const { sizes, intersect } = observers();
  const view = render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  act(() => sizes[0].deliver({ contentRect: { height: 9000 } }));
  intersect(0, false);
  expect(view.container.querySelector('[data-file-page="0"]')?.getAttribute("style")).toContain("9000px");
});

it("pins the focused page and its neighbors for keyboard traversal, then releases them on blur", () => {
  const { intersect } = observers();
  const view = render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  const target = screen.getByText("file-199.ts");
  act(() => target.focus());
  intersect(0, false);
  expect(document.activeElement).toBe(target);
  expect(screen.getByText("file-200.ts")).toBeTruthy();
  act(() => screen.getByText("file-399.ts").focus());
  expect(screen.getByText("file-400.ts")).toBeTruthy();
  fireEvent.blur(document.activeElement!, { relatedTarget: null });
  expect(view.container.querySelectorAll('button')).toHaveLength(0);
});

it("retains a text-selected page until the selection is cleared", () => {
  const { intersect } = observers();
  render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("file-0.ts"));
  document.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  intersect(0, false);
  expect(screen.getByText("file-0.ts")).toBeTruthy();
  document.getSelection()!.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByText("file-0.ts")).toBeNull();
});

it("disconnects observers and ignores callbacks delivered after unmount", () => {
  const { intersections, sizes } = observers();
  const view = render(<FileTreeFilePages items={items} renderFile={renderFile} />);
  view.unmount();
  expect([...intersections, ...sizes].every((observer) => observer.disconnect.mock.calls.length)).toBe(true);
  act(() => {
    intersections.forEach((observer) => observer.deliver({ isIntersecting: true }));
    sizes.forEach((observer) => observer.deliver({ contentRect: { height: 9000 } }));
  });
  expect(view.container.childElementCount).toBe(0);
});

it("windows a small directory under the shared tree budget and restores it when the budget falls", () => {
  const { intersections, intersect } = observers();
  const budget = new TreeRenderBudget();
  const elsewhere = budget.register();
  render(<TreeRenderBudgetContext.Provider value={budget}>
    <FileTreeFilePages items={items.slice(0, 100)} renderFile={renderFile} />
  </TreeRenderBudgetContext.Provider>);
  expect(intersections).toHaveLength(0);
  act(() => elsewhere.update(701));
  expect(intersections).toHaveLength(1);
  intersect(0, false);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  act(() => elsewhere.release());
  expect(screen.getAllByRole("button")).toHaveLength(100);
  expect(intersections[0].disconnect).toHaveBeenCalled();
});

it("rechecks existing selection when windowing turns on and clears stale selection pins when off", () => {
  const { intersect } = observers();
  const budget = new TreeRenderBudget();
  const elsewhere = budget.register();
  render(<TreeRenderBudgetContext.Provider value={budget}>
    <FileTreeFilePages items={items.slice(0, 100)} renderFile={renderFile} />
  </TreeRenderBudgetContext.Provider>);
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("file-0.ts"));
  document.getSelection()!.addRange(range);
  act(() => elsewhere.update(701));
  intersect(0, false);
  expect(screen.getByText("file-0.ts")).toBeTruthy();
  act(() => elsewhere.update(0));
  document.getSelection()!.removeAllRanges();
  act(() => elsewhere.update(701));
  intersect(0, false);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
