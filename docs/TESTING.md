# 测试与验证说明

## 1. 当前状态：V3 与 V2 分开记录

本项目区分**测试代码存在、某次运行通过、真实外部服务可用、真实用户能完成任务**。本文依据主协调交接与 [V3 验证记录](V3_VALIDATION.md) 整理，文档 Worker 未另跑全量测试或新增真实服务请求。

| 范围 | 已有证据 | 结论边界 |
| --- | --- | --- |
| V3单元/接口 | 最新 `npm test`：121 tests / 121 pass / 0 fail | 含25个auto-data用例，不另行累加；合成/mock/本机HTTP回归 |
| V3浏览器 | `npm run test:e2e` 8条通过、0失败 | 本机构造数据，覆盖一键流程、单确认、差异、错误、历史和移动端 |
| V3真实模型 | 明确3条件、`needsConfirmation=false`、2567ms；模糊5条件、3解释、`needsConfirmation=true`、8486ms；均HTTP200 | 本机有限案例，不是准确率或P95 |
| V3真实auto数据 | 12股、正常19主源请求、HTTP200、1570ms；一次 `CACHE_REUSE=true` | 本机全12观察样本，不是全市场、云端性能或长期稳定性 |
| V3真实筛选 | 年度增长+PE+波动率五条件：HTTP200，5通过/7未通过/0整体未知 | 不代表所有单项无缺失或有投资收益 |
| V2历史回归/公网 | 79单元/接口+6浏览器；线上运行提交 `a8462ee` | 旧版错误横幅已修复；历史通过不能替代V3验收 |
| V3发布与视觉 | 部署SUCCESS，运行`77ca4f3`，完整设计检查通过 | 独立公网Chromium真实明确/模糊流程通过，无脚本错误；已查看本机首页与结果截图 |

V2历史资料：[公网验证（历史）](PRODUCTION_VALIDATION.md)、[错误横幅修复（历史）](ERROR_BANNER_FIX.md)。公网与GitHub已更新V3，云端扶摇已配置。最新发布实测见[V3验证记录](V3_VALIDATION.md)，不把历史V2测试当作V3证明。

## 2. 可复现的离线回归

Node.js 20+，在项目根目录执行：

```bash
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run check:design
```

`npm ci` 和 Chromium 安装可能下载依赖；测试本身使用合成数据、mock 或本机随机端口，不需要真实模型/数据凭证。不要将真实收费请求混进普通回归。

专项定位：

```bash
node --test tests/engine.test.mjs tests/intent.test.mjs tests/llm.test.mjs
node --test tests/data.test.mjs tests/auto-data.test.mjs tests/ifind.test.mjs
node --test tests/snapshot-cache.test.mjs tests/workflow-v3.test.mjs
node --test tests/setup.test.mjs tests/setup-fuyao.test.mjs tests/review-access.test.mjs tests/server.test.mjs
```

`npm test` 对应 `tests/*.test.mjs`，不包含 `.e2e.mjs`。浏览器测试自行启动随机端口，以 `env:{}` 隔离真实配置，注入的 `auto` 快照也明确为合成测试数据，不能算真实供应商覆盖。截图默认进入 `artifacts/`，可用 `PICODE_ARTIFACT_DIR` 指定目录；不要整目录公开上传。

最终应记录：测试时间、冻结commit、Node/Chromium版本、命令、退出码、通过/失败数量、截图和失败摘要。当前数量是最近一次交接结果，不保证随后代码改动仍然通过。

## 3. 测试文件与风险映射

| 文件 | 重点约束 |
| --- | --- |
| `tests/engine.test.mjs` | 有限数值、严格/包含边界、冲突、AND三值逻辑、未知不通过、失败优先但保留单项未知、单位/期间/日期、同快照差异 |
| `tests/intent.test.mjs` / `tests/llm.test.mjs` | 明确阈值保真、模糊假设、原文锚定不支持项、结构计数、合规、schema、模型失败不降级、仅服务端传递凭证 |
| `tests/workflow-v3.test.mjs` | 明确无需二次确认、模糊需确认年度假设、原累计同比不自动改年度、同快照修改、不支持要求阻止自动执行 |
| `tests/auto-data.test.mjs` | 25个合成用例：12样本10+2分组/19请求、并发≤2、零不必要iFinD、缺字段有限补充、日历与上海时区、年度原值/分母/币种/期间、价格对齐、ROE单位、业务失败/超时/脱敏、全空失败 |
| `tests/data.test.mjs` / `tests/ifind.test.mjs` | 历史适配的协议、缺失、真实日期口径、无凭证不fallback、公开开关、未来/陈旧日期、错误脱敏与队列边界 |
| `tests/snapshot-cache.test.mjs` | 15分钟TTL、上海跨日失效、singleflight、失败不缓存、返回隔离；与服务端快照存储生命周期区分 |
| `tests/server.test.mjs` | 实际本机HTTP但注入合成依赖；确认字段、条件schema/冲突、缓存ID、410失效、无demo降级、同源、请求大小、速率限制、静态白名单 |
| `tests/setup.test.mjs` / `tests/setup-fuyao.test.mjs` | 共用本机配置服务的Host/Origin/令牌/替换保护、0700/0600权限、供应商独立验证、私有配置不回显、失败不保存 |
| `tests/review-access.test.mjs` | 生产模型/金融凭证及配置路径需评审保护，短口令拒绝、健康检查例外、认证行为 |
| `tests/browser.e2e.mjs` | 下列8个V3合成浏览器流程；**用例已写，结果待补** |

### 新版8条浏览器用例的验收范围

1. 明确条件一次提交自动取数筛选，无 `dataMode`/`loadDataBtn`、无假错误横幅。
2. 模糊意图显示年度解释与5条件，无复选框，只确认一次，未确认不筛选。
3. 修改阈值保持焦点、复用同一快照，旧结果不可保存/导出，更新后差异正确。
4. 证据查看、当前JSON导出、本地保存和只读历史恢复。
5. 冲突、不支持和合规阻断不静默执行；恢复成功清除错误。
6. 自动数据失败保留真实错误，只请求auto，不自动回退demo。
7. 解析在飞时输入变化，旧响应不能作为新输入执行。
8. 390px手机深色无页面横向溢出，“数据与口径”不要求选择供应商。

这些用例不自动覆盖所有候选横向比较、键盘/读屏、存储损坏、复杂乱序和浏览器组合；最终仍需人工走查，不以测试名称代替运行证据。

## 4. V3 本机真实服务验证

### 模型

提示词 `intent-v2.0`，两类真实请求结果：

| 输入类型 | HTTP / 模式 | 条件与分流 | 单次耗时 |
| --- | --- | --- | --- |
| 明确PE/ROE阈值 | 200 / llm | 3条件、无clarifications、`needsConfirmation=false` | 2567ms |
| 经营改善/估值合理/走势相对稳定 | 200 / llm | 5条件、3解释、`needsConfirmation=true` | 8486ms |

这只证明有限案例下的真实分流。模型列表验证不能替代推理；HTTP200不能独立证明语义正确；不能用两条样本推导准确率、P95或SLA。

### 自动数据与筛选

| 指标 | 本机真实覆盖 |
| --- | --- |
| `pe_ttm`、`pb_mrq`、`roe` | 各12 `ok` |
| `volatility_20d`、`return_20d` | 各12 `ok` |
| `revenue_yoy_annual` | 12 `ok` |
| `profit_yoy_annual` | 11 `ok`、1 `missing` |
| `revenue_yoy`、`profit_yoy`、`market_cap` | 各12 `missing` |

自动快照HTTP200、1570ms，主源扶摇正常19请求；本次无需iFinD，缓存复用一次为true。五条件筛选5通过/7未通过/0整体未知；已知失败会使股票归为未通过，但其未知字段仍在证据中。

auto日期由交易日历驱动，估值元数据时间单列；年度使用相邻已披露完整年度，原累计/季度口径不偷换。年度两年raw与计算项可核对，ROE按官方百分数值解释。技术边界见 [AUTO_DATA.md](AUTO_DATA.md)；该文档的数据Worker阶段记录早于主协调全12股验证，最新整链路覆盖以 [V3_VALIDATION.md](V3_VALIDATION.md) 为准。

不自动重跑真实探测；已有授权不等于无限额度。真实原始响应不入公共fixture，公开材料只保留必要结构、计数与安全结论。

## 5. V3 发布前待验收清单

以下**未预先勾选**，由主协调在冻结版本操作后更新：

- [ ] 全量 `npm test`、8条浏览器E2E、完整设计检查在同一冻结版本通过并保存输出。
- [ ] 桌面1440与手机390深色走查：无溢出、键盘焦点可见、弹窗可关闭；无伪行情装饰，非官方/12样本标识清楚。
- [ ] 明确单提交、模糊单确认，无供应商选择、手动加载和解释复选框。
- [ ] 逐字段来源/日期/期间/单位/原始证据、年度两年计算、通过/未通过/数据不足含义正确。
- [ ] 2–3候选横向比较、同快照更新、旧结果禁保存导出、V3 schema与历史只读恢复走查。
- [ ] 新输入/晚到响应、模型/数据/筛选失败、重试恢复不残留可执行旧状态或假错误横幅。
- [ ] 缓存命中保持ID与日期；TTL/跨日/重启后有明确重新查询提示。
- [ ] 云端扶摇Secret、生产评审访问、HTTPS、Origin、出站权限和供应商错误完成V3公网验证。
- [ ] 公网静态路径不能读取 `.env`、`.local/` 或源码；日志/截图/包中无秘密和私有数据。
- [ ] 公网运行commit、GitHub、文档、截图和脱敏提交包一致，候选人本人完成演示。

## 6. 仍缺的证据

真实用户可用性、效率/满意度、广泛模型标注集和重复采样、语义漏项/误拒绝率、足量延迟分布、长时负载/内存、账号级额度、共享代理与多实例、一致性/安全/无障碍完整审计、Safari/Firefox和弱网仍未验证。数据账户长期额度、再分发权益及平台持续可用性也不能从一次成功推出。

发布优先阻断错误结论、静默丢条件、密钥泄露、模式标识不真实和必交链接不可用，而不是追求脱离场景的通过率数字。
