# DevAtlas 系统架构

## 总体架构

```mermaid
flowchart LR
    U[浏览器用户] --> UI[React + TypeScript 管理台]
    UI -->|REST / multipart| API[FastAPI 路由层]

    subgraph Import[仓库接入]
        ZIP[ZIP 安全解压]
        DIR[文件夹上传]
        GH[GitHub 下载]
        JOB[后台任务与进度]
    end

    subgraph Analysis[本地分析引擎]
        SCAN[文件扫描与 SHA-256]
        PARSE[Tree-sitter 结构解析]
        SEARCH[BM25 代码索引]
        GRAPH[依赖图与环检测]
        QUALITY[六条质量规则]
        REPORT[本地报告与模型增强]
        INC[增量变更分析]
    end

    API --> JOB
    JOB --> ZIP
    JOB --> DIR
    JOB --> GH
    ZIP --> SCAN
    DIR --> SCAN
    GH --> SCAN
    SCAN --> PARSE
    PARSE --> SEARCH
    PARSE --> GRAPH
    GRAPH --> QUALITY
    QUALITY --> REPORT
    PARSE --> REPORT
    INC --> SCAN
    INC --> PARSE
    INC --> SEARCH

    subgraph Persistence[本地持久化]
        DB[(SQLite)]
        REPO[(仓库文件目录)]
    end

    SCAN --> REPO
    JOB --> DB
    PARSE --> DB
    SEARCH --> DB
    GRAPH --> DB
    QUALITY --> DB
    REPORT --> DB
    API --> DB
```

可选模型增强通过统一的报告生成接口接入 Ollama 本地模型服务或 OpenAI Responses API。默认本地分析不依赖外部模型；模型服务地址和认证配置保存在根目录 `data/` 中，不进入版本控制。

## 导入与分析时序

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as FastAPI
    participant J as Background Job
    participant S as Scanner / Parser
    participant D as SQLite

    B->>A: 上传 ZIP、文件夹或 GitHub URL
    A->>D: 创建 queued 任务
    A-->>B: 返回 job_id
    A->>J: 在线程池启动分析
    loop 轮询进度
        B->>A: GET /jobs/{job_id}
        A-->>B: stage + progress
    end
    J->>S: 保存、扫描、解析、构建索引
    S->>D: 写入文件、符号、依赖、问题和代码片段
    J->>D: 标记 completed
    B->>A: 获取项目详情与结构
    A-->>B: 返回本地分析结果
```

## 增量分析策略

1. 先比较文件大小和纳秒级修改时间，快速跳过确定未变化的文件。
2. 元数据变化时计算 SHA-256，区分“时间戳变化”和“内容变化”。
3. 仅对新增和内容变化的源文件执行 Tree-sitter 解析。
4. 删除文件时同步清理符号、导入关系、解析问题和搜索片段。
5. 内容确实变化后刷新导入解析和 BM25 索引；无变化时返回 207 B 左右的轻量摘要。

## 为什么需要数据库

SQLite 用于保存项目、文件元数据、内容哈希、后台任务、符号、导入关系、解析问题和搜索片段，使分析结果可以在重启后继续使用。原始仓库文件仍保存在本地目录中，数据库不承担大文件对象存储。该组合无需额外部署数据库服务，适合个人电脑和简历演示。

## 关键设计取舍

| 设计 | 当前选择 | 原因 |
|---|---|---|
| 数据库 | SQLite | 零运维、可持久化、便于本地演示 |
| 任务系统 | 进程内线程池 + 持久化任务表 | 不引入 Redis/Celery 成本，同时保留阶段进度 |
| 语法解析 | Tree-sitter | 跨语言、速度快、不执行仓库代码 |
| 搜索 | BM25 | 完全本地、结果可解释、无需向量 API |
| 报告 | 本地规则默认 + 可选模型增强 | 无配置即可使用，同时为本地或在线模型预留扩展点 |
| 增量检测 | 元数据快路径 + SHA-256 | 兼顾速度与内容正确性 |
| 原始代码 | 本地文件系统 | 避免将完整仓库存入关系数据库 |
