const numberFormatter = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatNumber(value: number): string { return numberFormatter.format(value); }
export function formatDate(value: string): string { return dateFormatter.format(new Date(value)); }

export function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: "任务排队中",
    checking_remote: "正在检查远端版本",
    downloading_update: "正在下载远端更新",
    staging_analysis: "正在验证新版本",
    sync_scanning: "正在扫描新版本",
    sync_parsing: "正在解析新版本",
    sync_indexing: "正在建立新版本索引",
    sync_finalizing: "正在切换新版本",
    up_to_date: "已是最新版本",
    synchronized: "远程同步完成",
    downloading: "正在下载仓库",
    preparing: "正在准备文件",
    scanning: "正在扫描仓库",
    parsing: "正在解析代码结构",
    indexing: "正在建立搜索索引",
    finalizing: "正在整理结果",
    completed: "分析完成",
    failed: "分析失败",
  };
  return labels[stage] ?? "后台分析中";
}
