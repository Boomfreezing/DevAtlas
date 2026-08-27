// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { pickFolderSafely, scanDroppedFolderSafely, supportsSafeFolderPicker } from "./safeFolderPicker";

interface MockHandle {
  kind: "file" | "directory";
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterableIterator<MockHandle>;
}

function fileHandle(name: string, content: string): MockHandle {
  return { kind: "file", name, getFile: async () => new File([content], name) };
}

function directoryHandle(name: string, entries: MockHandle[], onRead?: () => void): MockHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      onRead?.();
      for (const entry of entries) yield entry;
    },
  };
}

describe("safe folder picker", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "showDirectoryPicker");
    vi.restoreAllMocks();
  });

  it("skips risky directories before reading their contents", async () => {
    const dependencyRead = vi.fn();
    const root = directoryHandle("demo", [
      directoryHandle("src", [fileHandle("main.py", "print('ok')")]),
      directoryHandle("node_modules", [fileHandle("huge.js", "generated")], dependencyRead),
      fileHandle("logo.png", "image"),
    ]);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn().mockResolvedValue(root) });

    const result = await pickFolderSafely({ max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });

    expect(supportsSafeFolderPicker()).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].webkitRelativePath).toBe("demo/src/main.py");
    expect(result.preview.skippedDirectoryCount).toBe(1);
    expect(result.preview.unsupportedCount).toBe(1);
    expect(result.preview.skippedDirectoryNames).toEqual(["node_modules"]);
    expect(dependencyRead).not.toHaveBeenCalled();
  });

  it("stops traversal when cancellation is requested", async () => {
    const root = directoryHandle("demo", [fileHandle("main.py", "print('ok')")]);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn().mockResolvedValue(root) });
    const controller = new AbortController();
    controller.abort();

    await expect(pickFolderSafely(
      { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lazily scans a dropped folder without opening ignored directories", async () => {
    const dependencyRead = vi.fn();
    const legacyFile = (name: string, content: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (success: (file: File) => void) => success(new File([content], name)),
    });
    const legacyDirectory = (name: string, entries: unknown[], onRead?: () => void) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let finished = false;
        return {
          readEntries: (success: (items: unknown[]) => void) => {
            onRead?.();
            if (finished) success([]);
            else { finished = true; success(entries); }
          },
        };
      },
    });
    const root = legacyDirectory("demo", [
      legacyDirectory("src", [legacyFile("main.ts", "export const ok = true;")]),
      legacyDirectory("node_modules", [legacyFile("huge.js", "generated")], dependencyRead),
    ]);
    const dataTransfer = { items: [{ kind: "file", webkitGetAsEntry: () => root }] } as unknown as DataTransfer;

    const result = await scanDroppedFolderSafely(dataTransfer, { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });

    expect(result.files.map((file) => file.webkitRelativePath)).toEqual(["demo/src/main.ts"]);
    expect(result.preview.skippedDirectoryNames).toEqual(["node_modules"]);
    expect(dependencyRead).not.toHaveBeenCalled();
  });
});
