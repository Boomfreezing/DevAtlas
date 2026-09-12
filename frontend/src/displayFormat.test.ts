import { expect, it } from "vitest";
import { formatDate, formatNumber, stageLabel } from "./displayFormat";

it("preserves the previous date/number formatting and job labels", () => {
  for (const value of [0, 1234567, -12.5]) expect(formatNumber(value)).toBe(new Intl.NumberFormat("zh-CN").format(value));
  const date = "2026-09-12T05:00:00Z";
  expect(formatDate(date)).toBe(new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date)));
  expect(stageLabel("sync_parsing")).toBe("正在解析新版本");
  expect(stageLabel("unknown")).toBe("后台分析中");
});
