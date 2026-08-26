# DevAtlas

DevAtlas 是一个本地优先的代码仓库分析平台。当前版本支持导入 ZIP、本地文件夹和公开 GitHub 仓库，并使用 Tree-sitter 在本地提取 Python、TypeScript 和 JavaScript 的函数、类、方法及导入关系。

## 当前进度

- [x] React + TypeScript 管理台
- [x] Terminal CLI 深色设计系统与响应式终端布局
- [x] FastAPI REST API
- [x] SQLite 项目与文件模型
- [x] ZIP 上传、大小限制和路径穿越防护
- [x] 本地项目文件夹导入
- [x] 公开 GitHub 仓库 URL 导入
- [x] GitHub 域名、重定向、超时和下载大小限制
- [x] Tree-sitter Python、TypeScript、JavaScript 结构解析
- [x] 函数、类、接口、方法和行号提取
- [x] `import`、`from`、`require` 依赖提取
- [x] 项目内相对依赖解析
- [x] 解析问题记录与旧项目重新分析
- [x] 递归文件扫描和忽略目录
- [x] 主要语言、文件数量与代码行数统计
- [x] 按函数、类和模块切分代码片段
- [x] BM25 项目内代码搜索
- [x] 返回文件路径、行号、代码片段、相关性得分和耗时
- [x] 模块依赖图 API 与交互式 SVG 图谱
- [x] 图谱缩放、路径筛选和节点入度/出度详情
- [x] 基于强连通分量的循环依赖检测
- [x] 六条代码质量规则与百分制评分
- [x] 按严重级别和规则筛选的结构化质量报告
- [x] 每项问题包含文件、行号、指标、阈值与修复建议
- [x] 一键生成并下载本地 Markdown 综合分析报告
- [x] 持久化后台分析任务和阶段进度
- [x] ZIP、文件夹与 GitHub 任务式导入
- [x] 服务中断任务恢复与失败清理
- [x] 文件哈希增量分析与未改动文件快速跳过
- [x] 新增、修改、删除文件识别和按需结构刷新
- [x] 项目列表、详情和删除
- [x] Pytest 单元及接口测试
- [x] Playwright 真实前后端端到端测试
- [x] 可复现增量分析性能评测脚本与报告
- [x] Docker Compose 配置
- [x] GitHub Actions 持续集成
- [ ] 本地向量搜索

完整阶段安排参见 [项目推进计划](./docs/PROJECT_PLAN.md)。性能测试口径与实测数据参见 [性能评测](./docs/PERFORMANCE.md)。

## 项目展示

![DevAtlas 仓库概览](./docs/assets/devatlas-dashboard.png)

![DevAtlas 代码质量报告](./docs/assets/devatlas-quality.png)

- [文档导航](./docs/README.md)
- [系统架构与关键设计取舍](./docs/ARCHITECTURE.md)
- [项目推进计划](./docs/PROJECT_PLAN.md)
- [性能评测](./docs/PERFORMANCE.md)
- [依赖图谱截图](./docs/assets/devatlas-graph.png)
- [代码搜索截图](./docs/assets/devatlas-search.png)
- [2～3 分钟演示脚本](./docs/DEMO_SCRIPT.md)
- [发布与简历交付清单](./docs/DELIVERY.md)

## 技术栈

- 前端：React 19、TypeScript、Vite
- 后端：Python、FastAPI、SQLAlchemy
- 数据库：SQLite
- 测试：Pytest、Vitest、Playwright
- 交付：Docker Compose

## 仓库结构

```text
DevAtlas/
├─ backend/                 FastAPI、SQLAlchemy、Tree-sitter 与后端测试
├─ frontend/                React、TypeScript、Vitest 与 Playwright
├─ docs/                    架构、计划、性能、演示和项目截图
│  └─ assets/               README 与演示使用的可复现截图
├─ scripts/                 性能评测等维护脚本
├─ data/                    SQLite、仓库文件和报告（运行时数据，不提交）
├─ .github/workflows/       GitHub Actions 持续集成
├─ .env.example             本地配置模板
└─ docker-compose.yml       一键容器化启动
```

根目录 `data/` 是本地开发和 Docker 共用的唯一运行数据目录。数据库、导入的仓库、模型配置和测试产物均已通过 `.gitignore` 排除，只有用于保留目录结构的 `.gitkeep` 文件进入版本控制。

## 本地开发

### 1. 启动后端

在 PowerShell 中执行：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload
```

后端地址：<http://localhost:8000>  
接口文档：<http://localhost:8000/docs>

后端从仓库根目录读取可选的 `.env`，所有相对数据路径也统一以仓库根目录解析。可先复制 `.env.example` 为 `.env` 再按需修改。

### 2. 启动前端

打开另一个 PowerShell：

```powershell
cd frontend
npm install
npm run dev
```

前端地址：<http://localhost:5173>

Vite 会把 `/api` 请求代理到本地 FastAPI 服务。

项目导入后可在详情页选择“增量分析”或“全量”。增量分析先用文件大小和纳秒级修改时间快速判断，元数据变化时再以 SHA-256 内容哈希确认；只有新增或内容变化的源文件会重新执行 Tree-sitter 解析，删除文件对应的符号、依赖、问题和搜索片段会同步清理。

## Docker 启动

如果已经安装 Docker Desktop：

```powershell
docker compose up --build
```

访问 <http://localhost:8080>。SQLite 数据库和上传的仓库保存在根目录的 `data/` 中。

## 测试

从仓库根目录运行完整验证（文档链接、后端覆盖率、前端测试、构建和端到端测试）：

```powershell
.\scripts\verify_project.ps1
```

也可以分别执行：

```powershell
cd backend
python -m pytest

cd ..\frontend
npm test
npm run build
npm run test:e2e
```

端到端测试会使用系统 Chrome，自动创建唯一的临时项目，并在测试结束后通过 API 删除该项目。CI 中会安装 Playwright Chromium 后执行同一套测试。

如需重新生成 README 展示截图，可执行 `npm run capture:assets`。该命令会在 8010/5174 端口启动隔离环境，不读取或修改日常使用的项目数据库。

## API 概览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 上传 ZIP 并分析 |
| POST | `/api/projects/folder` | 上传本地文件夹并分析 |
| POST | `/api/projects/github` | 下载公开 GitHub 仓库并分析 |
| POST | `/api/projects/jobs/zip` | 创建 ZIP 后台分析任务 |
| POST | `/api/projects/jobs/folder` | 创建文件夹后台分析任务 |
| POST | `/api/projects/jobs/github` | 创建 GitHub 后台分析任务 |
| GET | `/api/projects/jobs/{job_id}` | 查询任务阶段、进度与结果 |
| GET | `/api/projects/{id}` | 项目及文件详情 |
| GET | `/api/projects/{id}/structure` | 函数、类、依赖和解析问题 |
| GET | `/api/projects/{id}/search?q=关键词&limit=10` | BM25 项目内代码搜索 |
| GET | `/api/projects/{id}/dependency-graph?limit=40` | 模块依赖图与循环依赖 |
| GET | `/api/projects/{id}/quality?limit=300` | 质量评分、规则命中与修复建议 |
| GET | `/api/projects/report-generators` | 查询报告生成接口、可用状态与成本标签 |
| PUT | `/api/projects/report-generators/{provider}` | 从界面保存服务地址、模型和脱敏认证配置 |
| POST | `/api/projects/report-generators/{provider}/test` | 测试 Ollama 或 OpenAI Responses API 连接 |
| GET | `/api/projects/{id}/report?generator=local` | 生成可预览的针对性智能分析报告 |
| GET | `/api/projects/{id}/report.md` | 生成并下载本地 Markdown 综合报告 |
| POST | `/api/projects/{id}/incremental-reanalyze` | 检测文件变化并按需重新解析 |
| POST | `/api/projects/{id}/reanalyze` | 重新执行代码结构解析 |
| DELETE | `/api/projects/{id}` | 删除项目和本地数据 |

“分析报告”是独立的项目功能页。默认选择免费的本地智能分析接口，无需 API Key，报告会结合项目规模、依赖热点、质量评分、测试文件信号和解析完整度生成针对性结论。Ollama 本地模型服务与 OpenAI Responses API 可以直接在接口卡片中填写地址、模型和认证信息，并执行连接测试；配置成功后即可选择该接口增强报告。Responses 入口不直接兼容 DeepSeek、Claude 等供应商的原生协议，需要额外的 Chat Completions 或 Anthropic Messages 适配器。

接口配置保存在本机后端的 `data/report-providers.json`（已被 Git 忽略）。API Key 不会通过查询接口回传，也不会写入前端代码。若项目被部署为多人服务，建议进一步改用操作系统凭据存储或专用密钥管理服务。

报告生成后可在页面中直接预览。点击“导出 MD”会在支持 File System Access API 的 Chromium 浏览器中打开系统保存窗口，允许选择目录和文件名；其他浏览器自动回退为普通下载。

## 安全边界

- 支持 ZIP、本地文件夹和公开 GitHub 仓库根地址。
- 默认上传限制为 50 MB。
- 解压前检查绝对路径和 `..` 路径穿越。
- 默认忽略 `.git`、`node_modules`、`dist`、`build` 等目录。
- 只扫描已知的文本和源代码扩展名。
- 所有分析均在本地完成，不调用付费大模型 API。
- Markdown 报告使用确定性规则和已有分析数据生成，无需配置模型或 API Key。
- GitHub 导入只下载默认分支的源文件，不执行仓库代码。
- 旧版本已经导入的项目可在详情面板点击“全量”生成结构数据，后续使用“增量分析”更新。

本项目仍处于开发阶段，不建议用它分析不可信且包含敏感信息的仓库。
