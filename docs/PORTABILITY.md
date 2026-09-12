# 跨平台启动与路径兼容性

更新日期：2026-09-12。本记录区分真实运行、CI 运行和静态审查，不将路径模拟写成对应操作系统已经验收。

## 当前结论

| 环境 | 证据 | 当前结论 |
|---|---|---|
| Windows 11 / Python 3.13 / Node.js 24 | 从提交 `18e317d` 创建不含既有虚拟环境、`node_modules`、数据库和缓存的 D 盘副本；重新安装依赖、生产构建并运行隔离 E2E | 冷启动链路实际通过，42/42 项 E2E 成功 |
| Ubuntu GitHub Hosted Runner | `f35751d` 的 backend、frontend、e2e 三个作业全部成功 | 已验证上一公开提交；`18e317d` 及本轮未推送内容仍需下次 CI 确认 |
| Ubuntu WSL2 | 本机存在 Ubuntu 发行版，但虚拟机服务返回 `HCS_E_SERVICE_NOT_AVAILABLE`，没有进入 Linux 用户空间 | 未执行，不能算 Linux 实机通过；这是当前主机虚拟化条件，不是 DevAtlas 测试结果 |
| macOS | 检查 POSIX 虚拟环境路径、`pathlib` 文件路径、Node `path`、Docker Linux 路径和启动命令 | 仅静态兼容审查，没有 macOS 机器或 runner 实测 |

## 启动入口

Windows 与 POSIX 的后端安装、启动命令已经分别写入[根 README](../README.md#本地开发)。命令直接调用虚拟环境中的 Python，不依赖 shell 激活脚本，避免 PowerShell 执行策略、Conda 初始化或 shell 类型影响解释器选择。

完整验证入口仍是 `scripts/verify_project.ps1`。它已实际在 Windows PowerShell 运行，并由 5 项回归覆盖 PowerShell 7、带空格路径、POSIX `.venv/bin/python` 选择、隔离环境以及失败恢复。Linux/macOS 使用该入口需要预先安装 `pwsh`；目前没有额外提供 Bash 一键入口。

## 路径和数据边界

- 后端运行目录使用 `pathlib.Path` 解析；归档内部路径先按 POSIX 形式验证，再映射到当前平台，拒绝绝对路径、`..`、符号链接和越界目标。
- 前端上传和图谱数据统一把仓库相对路径规范成 `/`，本机物理路径不进入浏览器数据模型。
- E2E 根据 `process.platform` 选择 `.venv/Scripts/python.exe` 或 `.venv/bin/python`，所有数据库、仓库副本、索引和临时文件均写入隔离运行目录。
- Docker Compose 将数据库、仓库、临时文件、索引和模型配置统一指向容器 `/data`，由宿主机项目根目录的 `data/` 挂载；不会把 Windows 盘符写入镜像。
- Docker 构建上下文排除本机虚拟环境、`node_modules`、缓存、覆盖率和测试输出；前端镜像使用 `package-lock.json` 与 `npm ci`，避免不同平台复用本机依赖目录。

## 冷启动验收

Windows 冷启动使用 `git archive` 从提交 `18e317d` 创建全新源码副本，路径同时包含中文和空格。Python 和 npm 的缓存、临时文件、数据库及 E2E 运行目录全部设置在该副本所属的 `data/tmp/cold-start/run-*` 下，不读取日常项目数据库或 API 配置，也不调用生成模型。

验收步骤：

1. 新建 `backend/.venv`，从 `pyproject.toml` 安装主依赖和 `dev` 依赖。
2. 使用 `npm ci` 从锁文件安装前端依赖。
3. 执行 TypeScript 与 Vite 生产构建。
4. 由 Playwright 启动隔离的后端和前端，执行 42 项浏览器回归。

同次冷启动命令最终以退出码 0 完成，生产构建成功，42/42 项 Playwright E2E 通过。npm 安装会报告测试依赖链 `whatwg-encoding` 的上游弃用提示，以及 npm 对 esbuild 安装脚本的审核提示；这两项应进入后续依赖审计，不能写成“全新安装零警告”。

## 尚未完成

- 本轮没有可用的 macOS 运行环境，因此不宣称 macOS 已通过安装或启动测试。
- Linux 最新源码应在下一次获得推送授权后由 GitHub Actions 重新验证；普通 Windows 冷启动不能替代该结果。
- Docker CLI 在当前主机不可用，本轮只检查配置和构建上下文；没有把静态 YAML 解析写成镜像构建成功。
- 当前 Windows 主机上，Playwright 42 项用例全部完成后，测试服务器清理阶段出现过两次不退出；相关进程已人工停止并确认清理。这不等同于用例失败，但在新增专用跨平台 E2E 进程管理入口前，也不能把这两次命令记为完整退出成功。
- 是否新增 Bash 一键入口、macOS CI 或额外 runner 属于后续工程范围，需要评估维护成本和执行成本后再决定。
