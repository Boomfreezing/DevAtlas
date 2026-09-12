# 依赖图谱：生产构建、文本节点与首次绘制

更新日期：2026-09-12。接续[上一轮图谱验收](./DEPENDENCY_GRAPH_PERFORMANCE.md)，本轮只打磨既有图谱；没有新增产品模块、菜单、接口、依赖库或数据库表，没有调用真实模型、同步用户仓库或推送 GitHub。

## 结论

减少不必要的文本 DOM 节点和 React 文本 Fiber 后，400 节点 / 2,000 边场景的首次聚焦中位耗时由 **172.51 → 154.97 ms**，强制 GC 后 JS 堆由 **11.70 → 8.94 MiB**。图形元素、节点、边、标签与循环行数量逐动作核对完全一致。

收益有边界：400 节点清空筛选 **204.03 → 201.61 ms**，不能称为明显提速；缩小等动作的总体计时出现回退。此次没有解决任意规模的 SVG 绘制和密集图可读性问题。

## 定位与修改

生产基线与独立 CPU profile 先采集，随后才修改产品源码。profile 使用同一已构建 bundle 和本地 sourcemap，并校验 bundle 哈希，避免分析到修改后的其他版本。

- 400 节点首次聚焦的基线 profile 中，React DOM 的 self 采样约 20.22 ms，模型准备文件约 2.51 ms；`completeWork` 的 inclusive 采样约 26.23 ms，另有 `createTextNode`、`appendChild` 等工作。CDP 记录的样式重算与布局也占用时间，因此不优先增加几何缓存或更换布局。
- 本地 React DOM 生产实现中，字符串 children 可直接设置文本内容；多个 JSX 片段组成的 children 则需要分别创建文本节点和 Fiber。原循环边标题有 9 段文本，×N 标签有 2 段，节点标题有 5 段。
- 仅在 `DependencyGraphView.tsx` 合并边标题、×N 标签、节点标题和循环路径说明这 4 处文本，仍使用 React 字符串渲染，不使用 HTML 注入。完整路径、导入次数、全部行号和循环标记保持原文；空路径数组不产生 `undefined`。
- 不改 CSS、配色、几何、筛选范围、布局、绘制批次、缓存、读取取消或选中逻辑，不减少节点或依赖边，不新增隐藏图层。

修改后独立 profile 的 `completeWork` inclusive 采样，首次聚焦约 21.58 ms、清空筛选约 21.09 ms；基线分别为 26.23 / 27.13 ms。这只是单次调用栈诊断，不是收益统计。inclusive 项互相重叠，self、native、样式和布局指标不能当作互斥项相加；`(program)` 和 `(idle)` 也不能归因给某个应用函数。

## 同条件实测

原始计时：[生产基线](./performance/dependency-graph-production-baseline.json)、[生产修改后](./performance/dependency-graph-production-after.json)。独立诊断：[基线 profile 汇总](./performance/dependency-graph-production-baseline-profile.json)、[修改后 profile 汇总](./performance/dependency-graph-production-after-profile.json)。

[完整动作对照](./performance/dependency-graph-production-comparison.json)保留两档共 38 个动作的中位值、script/task/layout/style、内存和结构计数，不只展示改善项目。

- Chrome 152.0.7977.83、Node 24.18.0、Windows，1440×1000 视口；Vite 生产构建 + preview。两档夹具每版各 3 个独立页面样本，每样本检查 19 个动作；fixture SHA-256 前后一致。
- 默认 40 节点 / 175 边；完整循环分别 240 节点 / 1,200 边和 400 节点 / 2,000 边，保留 20 条循环分组。所有业务请求均由合成 GET 响应提供，非 GET 请求会失败。
- 下面是每组 3 个样本的中位数，单位 ms。总耗时包含 Playwright 通信、动作、断言及两帧等待；选节点通过 DOM click，选边使用 Enter，不代表鼠标在密集图中寻找节点的耗时。
- CDP script/layout/style 是同区间累计量的增量，仍包含自动化的浏览器侧工作。profile 在独立运行中采集，没有混进计时样本。测试和性能测量串行执行，不把耗时设为 CI 通过门槛。

| 规模 / 动作 | 生产基线 | 修改后 |
|---|---:|---:|
| 240：首次循环聚焦 | 113.90 | 104.74 |
| 240：清空筛选 | 98.78 | 89.15 |
| 240：选中节点 | 40.60 | 34.69 |
| 240：放大 | 76.60 | 75.36 |
| 240：缩小 | 69.30 | 83.77 |
| 400：首次循环聚焦 | 172.51 | 154.97 |
| 400：清空筛选 | 204.03 | 201.61 |
| 400：选中节点 | 39.36 | 33.61 |
| 400：选中边 | 249.40 | 222.04 |
| 400：放大 | 152.45 | 121.09 |
| 400：缩小 | 60.79 | 128.76 |
| 400：返回模块详情 | 95.32 | 110.66 |

400 节点首次聚焦的 script 中位数为 41.51 → 31.25 ms，清空筛选为 35.21 → 26.08 ms。清空筛选的脚本成本降低约 26%，但总耗时只下降约 1%，不能混为同一指标。

默认 40 节点也没有全面加速：两组样本的节点选择分别为 28.16 → 33.84 ms、38.64 → 40.48 ms；首次打开分别为 107.46 → 101.91 ms、92.66 → 94.53 ms。400 节点缩小动作的 script 为 0.44 → 0.45 ms、layout 为 10.03 → 7.57 ms，但总体计时显著变慢，当前证据不能精确归因该差异；需要进一步独立采样，不能将它删去或用最快一轮代替。

### 结构与内存

以下为完整循环刚聚焦后的结构；每个样本和全部动作另有完整计数保存在 JSON。

| 指标 | 240 节点：前 → 后 | 400 节点：前 → 后 |
|---|---:|---:|
| 图谱 DOM 元素数 | 6,950 → 6,950 | 11,430 → 11,430 |
| 图谱文本节点数 | 14,651 → 2,851 | 24,251 → 4,611 |
| SVG 标题文本节点数 | 12,000 → 1,440 | 20,000 → 2,400 |
| SVG 标签文本节点数 | 2,416 → 1,216 | 4,016 → 2,016 |
| 强制 GC 后聚焦态 JS 堆 / MiB | 8.85 → 7.12 | 11.70 → 8.94 |
| 强制 GC 后退出聚焦 JS 堆 / MiB | 6.20 → 5.81 | 6.58 → 6.26 |

400 节点场景减少了 19,640 个文本节点，其中 SVG 减少 19,600 个、循环说明减少 40 个；不是删除节点文件或边标签。DOM 元素与 DOM 文本节点是不同统计口径，仅统计 `querySelectorAll('*')` 无法发现这部分冗余。

堆数据在计时区间之外强制 GC 后测量，不代表浏览器 RSS、自然 GC 或峰值内存。上述均为固定本机合成场景的小样本，不具有 P95 或统计显著性保证。

上一轮开发构建的 400 节点首次聚焦为 387.64 ms，本轮修改前生产基线为 172.51 ms：这两个值构建环境不同，**不能把差额计入本次优化收益**。此前回退记录继续保留，未用生产数字覆盖历史开发测量。

## 验证结果

- 前端 **219 项通过**，比上一轮新增 3 项：单文本结构和全文、特殊文件名安全显示、空行号、筛选清空，以及长循环从加载、失败、重试到退出的状态回归。
- 全部 **23 项 Playwright 通过**，退出码 0，约 33.2 秒；保留真实隔离导入 → 搜索 → 无变化增量主流程，以及图谱键盘、双向边、自环、取消、重试、切换项目等回归。
- TypeScript/Vite 构建通过：JS 334.59 kB / gzip 103.92 kB，CSS 133.50 kB / gzip 23.85 kB。检查了新生成的图谱截图，绿色 Terminal 风格保留。
- 两版生产基准和两次独立 profile 均实际运行通过。没有将 `src` 的 TypeScript 构建等同于 perf 脚本独立类型检查；profile 使用 Vite 已有的 sourcemap 工具链，没有新增安装依赖。
- 独立输出目录完成后，另按下方复现命令执行计时和 profile，均通过；结果保留在 D 盘独立临时目录，没有替换上表的修改后样本。旧文件树两组基准、图谱计时和独立 profile 的测试发现检查也通过。21 份 Markdown 的本地链接与 diff 空白检查通过。
- 后端未改动，250 项 / 85.71% 是之前的历史验收，不标为本轮重跑。测试临时数据在 D 盘，使用独立 8011/5175 端口，不操作日常 8000/5173 服务。

## 复现

在 `frontend` 目录运行，与其他重型任务串行。生产基准默认拒绝覆盖历史 JSON；复测使用独立输出目录，保留所有样本。下面只复测当前源码，不能重新制造历史 baseline。

```powershell
$env:TEMP = (Resolve-Path '../data/tmp').Path
$env:TMP = $env:TEMP
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:DEVATLAS_GRAPH_BENCHMARK_BUILD = "production"
$env:DEVATLAS_GRAPH_BENCHMARK_LABEL = "after"
$env:DEVATLAS_GRAPH_BENCHMARK_OUTPUT_DIR = Join-Path $env:TEMP ("graph-benchmark-" + [guid]::NewGuid().ToString("N"))
$env:DEVATLAS_GRAPH_PROFILE = "false"
$env:DEVATLAS_GRAPH_PROFILE_EXISTING_BUILD = "false"
npx playwright test --config=playwright.performance.config.ts perf/dependency-graph.spec.ts

# 紧接上面的计时，不修改或重建 dist；校验同一 bundle 后采集独立 profile。
$env:DEVATLAS_GRAPH_PROFILE = "true"
$env:DEVATLAS_GRAPH_PROFILE_EXISTING_BUILD = "true"
npx playwright test --config=playwright.performance.config.ts
```

计时和诊断脚本分别为 [dependency-graph.spec.ts](../frontend/perf/dependency-graph.spec.ts) 与 [dependency-graph-profile.spec.ts](../frontend/perf/dependency-graph-profile.spec.ts)。原始 `.cpuprofile` 保存在 D 盘 `data/tmp/graph-profiles/`（Git 忽略），文档只保存汇总与哈希。生产 sourcemap 仅用于本地诊断，不改变普通构建或发布配置。

计时基线保存后只整理了脚本格式、删除未用 import，并增加独立输出目录选项；fixture、19 个动作和计时区间未改变，因此脚本哈希会变化。bundle 和产品源码哈希保留在测量当时的 JSON 中；profile 使用对应计时结果的 bundle 哈希校验。

## 下一步

继续完善既有**质量检测**：先检查切换项目、连续筛选、加载更多和失败重试的状态一致性，再对多页问题列表做渲染及内存基准。图谱缩放总耗时的波动保留为后续诊断项，不把当前结果作为全规模流畅的承诺。

若要引入新的绘图库、图谱分页、产品规模限制或其他新增能力，先征求用户确认。
