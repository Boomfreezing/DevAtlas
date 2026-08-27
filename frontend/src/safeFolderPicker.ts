import {
  ApiRequestError,
  formatUploadSize,
  isAnalyzableUploadFilename,
  isIgnoredUploadDirectory,
} from "./api";
import type { FolderUploadPreparation } from "./api";
import type { ImportLimits } from "./types";

interface SafeFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

interface SafeDirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<SafeFileHandle | SafeDirectoryHandle>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<SafeDirectoryHandle>;
}

interface LegacyFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface LegacyFileEntry extends LegacyFileSystemEntry {
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
}

interface LegacyDirectoryEntry extends LegacyFileSystemEntry {
  createReader(): {
    readEntries(success: (entries: LegacyFileSystemEntry[]) => void, failure?: (error: DOMException) => void): void;
  };
}

interface LegacyDataTransferItem {
  kind: string;
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
}

interface TraversalFile {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

interface TraversalDirectory {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<TraversalEntry>;
}

type TraversalEntry = TraversalFile | TraversalDirectory;

export interface FolderScanProgress {
  scannedEntries: number;
  acceptedFiles: number;
  acceptedBytes: number;
  skippedDirectories: number;
}

interface SafeFolderPickerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FolderScanProgress) => void;
}

const MAX_DIRECTORY_DEPTH = 24;
const PROGRESS_INTERVAL = 200;

export function supportsSafeFolderPicker(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

export function supportsSafeFolderDrop(): boolean {
  return typeof DataTransferItem !== "undefined" && "webkitGetAsEntry" in DataTransferItem.prototype;
}

export async function pickFolderSafely(
  limits: ImportLimits,
  options: SafeFolderPickerOptions = {},
): Promise<{ files: File[]; preview: FolderUploadPreparation }> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new ApiRequestError(
      "当前浏览器不支持点击式安全目录选择。建议：将项目文件夹拖入导入区域，或改用 ZIP 导入。",
      "选择本地文件夹",
      0,
      null,
    );
  }

  let root: SafeDirectoryHandle;
  try {
    root = await picker({ mode: "read" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiRequestError(
      "浏览器没有授予安全目录读取权限。建议：把文件夹拖入导入区域，或改用 ZIP 导入。",
      "选择本地文件夹",
      0,
      error instanceof Error ? error.message : null,
    );
  }
  return traverseFolders([adaptHandleDirectory(root)], limits, options);
}

export async function scanDroppedFolderSafely(
  dataTransfer: DataTransfer,
  limits: ImportLimits,
  options: SafeFolderPickerOptions = {},
): Promise<{ files: File[]; preview: FolderUploadPreparation }> {
  const roots = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => (item as unknown as LegacyDataTransferItem).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is LegacyFileSystemEntry => entry !== null);
  if (!roots.length) {
    throw new ApiRequestError(
      "没有读取到可遍历的文件夹。建议：从系统文件管理器拖入完整项目文件夹，而不是网页中的文件链接。",
      "拖入本地文件夹",
      0,
      null,
    );
  }
  const directories = roots.filter((entry): entry is LegacyDirectoryEntry => entry.isDirectory);
  if (!directories.length) {
    throw new ApiRequestError(
      "当前拖入内容不是文件夹。建议：直接拖入项目根目录，或切换到 ZIP 导入。",
      "拖入本地文件夹",
      0,
      null,
    );
  }
  return traverseFolders(directories.map(adaptLegacyDirectory), limits, options);
}

export function formatFolderScanProgress(progress: FolderScanProgress): string {
  return `已检查 ${progress.scannedEntries} 项 · 保留 ${progress.acceptedFiles} 个源码 / ${formatUploadSize(progress.acceptedBytes)} · 跳过 ${progress.skippedDirectories} 个目录`;
}

async function traverseFolders(
  roots: TraversalDirectory[],
  limits: ImportLimits,
  options: SafeFolderPickerOptions,
): Promise<{ files: File[]; preview: FolderUploadPreparation }> {
  const queue = roots.map((root) => ({ handle: root, relativePath: root.name, depth: 0 }));
  let queueIndex = 0;
  const acceptedFiles: File[] = [];
  const skippedDirectoryNames = new Set<string>();
  const maxScannedEntries = Math.max(limits.max_folder_files * 3, 30_000);
  const maxUploadBytes = limits.max_upload_mb * 1024 * 1024;
  const maxSourceFileBytes = limits.max_source_file_mb * 1024 * 1024;
  let scannedEntries = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let acceptedBytes = 0;
  let ignoredBytes = 0;
  let unsupportedCount = 0;
  let oversizedCount = 0;
  let skippedDirectoryCount = 0;

  while (queueIndex < queue.length) {
    assertNotAborted(options.signal);
    const current = queue[queueIndex++];
    for await (const entry of current.handle.entries()) {
      assertNotAborted(options.signal);
      scannedEntries += 1;
      if (scannedEntries > maxScannedEntries) {
        throw safetyError(`已检查超过 ${maxScannedEntries} 个目录项。建议：选择更具体的源码目录，或排除大型生成目录后重试。`);
      }

      if (entry.kind === "directory") {
        if (isIgnoredUploadDirectory(entry.name) || current.depth >= MAX_DIRECTORY_DEPTH) {
          skippedDirectoryCount += 1;
          skippedDirectoryNames.add(entry.name);
        } else {
          queue.push({ handle: entry, relativePath: `${current.relativePath}/${entry.name}`, depth: current.depth + 1 });
        }
      } else {
        scannedFiles += 1;
        const file = await entry.getFile();
        scannedBytes += file.size;
        if (!isAnalyzableUploadFilename(entry.name)) {
          unsupportedCount += 1;
          ignoredBytes += file.size;
        } else if (file.size > maxSourceFileBytes) {
          oversizedCount += 1;
          ignoredBytes += file.size;
        } else {
          acceptedBytes += file.size;
          if (acceptedFiles.length + 1 > limits.max_folder_files) {
            throw safetyError(`可分析源码超过 ${limits.max_folder_files} 个文件。建议：选择更具体的源码目录后重试。`);
          }
          if (acceptedBytes > maxUploadBytes) {
            throw safetyError(`待分析源码超过 ${limits.max_upload_mb} MB。建议：拆分项目目录或移除大型源码/数据文件后重试。`);
          }
          acceptedFiles.push(withRelativePath(file, `${current.relativePath}/${entry.name}`));
        }
      }

      if (scannedEntries % PROGRESS_INTERVAL === 0) {
        reportProgress(options.onProgress, scannedEntries, acceptedFiles.length, acceptedBytes, skippedDirectoryCount);
        await yieldToBrowser();
      }
    }
  }

  if (!acceptedFiles.length) {
    throw new ApiRequestError(
      "安全扫描完成，但没有找到可分析源码。建议：选择包含受支持源代码文件的项目目录。",
      "选择本地文件夹",
      0,
      null,
    );
  }
  reportProgress(options.onProgress, scannedEntries, acceptedFiles.length, acceptedBytes, skippedDirectoryCount);

  return {
    files: acceptedFiles,
    preview: {
      acceptedFiles,
      originalCount: scannedFiles,
      originalBytes: scannedBytes,
      ignoredCount: unsupportedCount + oversizedCount,
      ignoredBytes,
      totalBytes: acceptedBytes,
      directoryIgnoredCount: skippedDirectoryCount,
      unsupportedCount,
      oversizedCount,
      selectionMode: "safe",
      scannedEntryCount: scannedEntries,
      skippedDirectoryCount,
      skippedDirectoryNames: [...skippedDirectoryNames].sort().slice(0, 8),
    },
  };
}

function adaptHandleDirectory(handle: SafeDirectoryHandle): TraversalDirectory {
  return {
    kind: "directory",
    name: handle.name,
    entries: async function* () {
      for await (const entry of handle.values()) {
        yield entry.kind === "directory"
          ? adaptHandleDirectory(entry)
          : { kind: "file", name: entry.name, getFile: () => entry.getFile() };
      }
    },
  };
}

function adaptLegacyDirectory(entry: LegacyDirectoryEntry): TraversalDirectory {
  return {
    kind: "directory",
    name: entry.name,
    entries: async function* () {
      const reader = entry.createReader();
      while (true) {
        const batch = await readLegacyEntryBatch(reader);
        if (!batch.length) break;
        for (const child of batch) {
          if (child.isDirectory) yield adaptLegacyDirectory(child as LegacyDirectoryEntry);
          else if (child.isFile) yield adaptLegacyFile(child as LegacyFileEntry);
        }
      }
    },
  };
}

function adaptLegacyFile(entry: LegacyFileEntry): TraversalFile {
  return {
    kind: "file",
    name: entry.name,
    getFile: () => new Promise((resolve, reject) => entry.file(resolve, reject)),
  };
}

function readLegacyEntryBatch(reader: ReturnType<LegacyDirectoryEntry["createReader"]>): Promise<LegacyFileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function withRelativePath(file: File, relativePath: string): File {
  const uploadFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
  Object.defineProperty(uploadFile, "webkitRelativePath", { configurable: true, value: relativePath });
  return uploadFile;
}

function safetyError(detail: string): ApiRequestError {
  return new ApiRequestError(`文件夹扫描已安全停止：${detail}`, "选择本地文件夹", 0, null);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Folder scan cancelled", "AbortError");
}

function reportProgress(
  callback: SafeFolderPickerOptions["onProgress"],
  scannedEntries: number,
  acceptedFiles: number,
  acceptedBytes: number,
  skippedDirectories: number,
): void {
  callback?.({ scannedEntries, acceptedFiles, acceptedBytes, skippedDirectories });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
