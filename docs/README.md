# DevAtlas 文档导航

本目录集中保存 DevAtlas 的设计、验证和简历交付材料。根目录 `README.md` 负责快速启动，这里负责解释系统如何设计、如何验证以及如何演示。

## 文档地图

| 文档 | 用途 | 维护时机 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 总体架构、分析时序、数据持久化和关键取舍 | 架构或核心数据流变化后 |
| [PROJECT_PLAN.md](./PROJECT_PLAN.md) | 里程碑、优先级、真实指标和后续路线 | 完成一个里程碑后 |
| [PERFORMANCE.md](./PERFORMANCE.md) | 增量分析评测方法、样本和数据边界 | 重新运行性能评测后 |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) | 2～3分钟演示流程和简历描述参考 | 页面流程或指标变化后 |
| [DELIVERY.md](./DELIVERY.md) | GitHub发布、隐私检查和简历交付清单 | 每次正式发布前 |
| [assets/](./assets/) | 仓库概览、搜索、图谱、质量和报告截图 | UI发生明显变化后 |

## 信息来源原则

- 功能状态以自动化测试和当前代码为准。
- 性能数字必须来自 `scripts/benchmark_incremental.ps1` 的可复现结果。
- 测试数量和覆盖率应以最近一次本地或CI输出为准。
- API Key、SQLite数据库、导入的仓库和生成报告不得放入文档或截图。
- 简历只使用已经测量的数据，不使用计划值或占位数字。
