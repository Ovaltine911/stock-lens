# 数据来源与真实性边界

## 结论（运行探测记录：2026-11-08）

- 同花顺 Fuyao 文档：[快速开始](https://fuyao.aicubes.cn/docs/quickstart/)、[估值](https://fuyao.aicubes.cn/docs/api-reference/valuations/)、[行情](https://fuyao.aicubes.cn/docs/api-reference/prices/)、[财务报表](https://fuyao.aicubes.cn/docs/api-reference/financials/)。调用要求 `X-api-key`；接口业务错误通过 HTTP 200 的 `code` 表达。无凭证探测得到 `code=2001`（缺少/无效 API key），因此当前环境不能声称 Fuyao 有效数据。
- 公开行情探测：东方财富 `push2.eastmoney.com` quote 返回 HTTP 200、`rc=0`，可读取价格、PB、总市值字段；实测 `f162` 虽有数值，但仅能核验为动态 PE，不能确认 TTM，因此不映射 `pe_ttm`；`f124=0`，不能作为更新时间。`push2his.eastmoney.com` K 线返回 HTTP 200、`rc=0`，按运行时往前 100 个自然日请求，2026-11-08 探测返回 65 条日线。公开源没有在本适配器中推导财务同比或 ROE，保持 `null`。
- iFinD 官方 MCP 已通过独立适配器接入正式产品网页 API：完整 12 股、6 次工具请求成功，快照 HTTP 200、单次 25757ms；PE TTM/PB MRQ/报告期加权 ROE 各 12 项 `ok`，其余 5 类指标各 12 项 `missing`。它与 Fuyao 是不同服务，不可混用凭证或成功码。最新证据见 [LIVE_VALIDATION.md](LIVE_VALIDATION.md)。
- 同花顺文档响应中的示例数值仅说明结构，绝不作为样本数据。

## 四种模式

### `demo`

`asOf` 固定为历史模拟时间 `2024-12-31T00:00:00.000Z`，每次创建/加载的 `fetchedAt` 使用运行时 `new Date().toISOString()`；12 家公司均是虚构名称和代码（`XIN0001.D` 等），用于演示筛选中的通过、失败、未知与负 PE；来源显示为“合成演示数据（虚构，不是真实行情）”。不是投资推荐。

### `public`

公开模式是部署能力开关，不代表每次在线保证可用。只有环境变量 `PUBLIC_DATA_ENABLED=true` 时才允许加载；缺失或设为其他值（包括 `false`）会返回 `DATA_UNAVAILABLE`/503，不会静默降级。可交付的 `config.example` 默认 `PUBLIC_DATA_ENABLED=false`，部署者在确认使用条款后可显式开启。

`lib/data.mjs` 仅使用明确的东方财富公开 HTTP 接口：

- 行情/估值：`https://push2.eastmoney.com/api/qt/stock/get`，实证返回 `f167`（PB，按响应缩放/100）和 `f116`（市值，元，转换为亿元）；`f162` 虽返回数值，但公开字段语义无法稳定核验为 TTM（常见为动态 PE），所以适配器**不映射到 `pe_ttm`，保持 unknown/null**，避免误贴口径。`f124` 在当前实测返回 0，不能作为有效指标更新时间。
- 日线：`https://push2his.eastmoney.com/api/qt/stock/kline/get`，请求 `fields2=f51,f53`，实测返回逗号分隔的日期、收盘价（`date,close`）；适配器保留最近 21 条原始 `date,close` 记录，并计算 20 个对数收益，年化波动率为样本标准差 × `√252`，单位百分比；20 日收益为首尾价格变化百分比。请求窗口限制为当前时间往前约 100 个自然日，不再请求 2000–2099 全量。K 线末日是价格序列时点，不替代估值/财务指标时点。

源响应须是 HTTP 2xx，且业务 envelope 成功（东方财富 `rc=0`）；代码必须匹配请求。超时、HTTP 错误、JSON/业务协议异常会被标记 `error`，不会伪装为空成功；若 12 家全部失败则整个 public 快照返回 503，局部失败保留字段级 error。`f124` 若为有效毫秒时间则作为行情估值 asOf；无效（例如实测 0）时为 error/missing，不会以 null + ok 表示新鲜数据。实际指标时点与采集时点分开；K 线超过 7 个自然日标记 stale，未来日期标记 error，节假日可能误伤。

财务 `revenue_yoy`、`profit_yoy`、`roe` 未从可核验公开接口取得，证据为 `missing`/`null`；不要从行情数据猜测。

### `fuyao`

需要环境变量 `FUYAO_API_KEY`。估值端点批量请求真实代码，历史行情按不超过 10 代码分批请求，参数为 `interval=1d`、`adjust=forward`，查询最近约 90 个自然日，计算前强制截取最近 21 根有效收盘价。响应 `code !== 0` 即业务错误；HTTP 200 不等于成功。估值 `data.timestamp` 只作为本次响应上游指标元数据的最大有效时间，并用运行时 `Date.now()` 判断超过 7 个自然日/未来，证据注明不能解释为每个字段同步。当前适配器尚未接入 Fuyao 财务指标和总市值字段，保持 `null`。

无 `FUYAO_API_KEY` 时 `loadSnapshot('fuyao')` 明确抛出 `DATA_UNAVAILABLE`，不静默降级到 demo/public。

### `ifind`

由 `IFIND_API_KEY` 或显式 `IFIND_CONFIG_PATH` 在服务端授权；不默认搜索本机技能配置，也不将真实密钥放入前端。已完成本机正式产品 API 的完整快照与筛选，不再仅限于工具发现或两股探测。取数范围固定 12 股、3 组财务+估值共 6 次工具请求，不查询买卖信号。

| 指标 | 最新真实可用性 | 时间与口径 |
| --- | --- | --- |
| PE TTM、PB MRQ | 各 12 项 `ok` | 固定估值交易日 **2026-11-06**，源字段须明确 TTM/MRQ |
| 报告期加权 ROE | 12 项 `ok` | 固定财务报告期 **2026-09-30**，不是公告日或可获得日，不声称报告期末已可得 |
| 营收同比、归母利润同比 | 各 12 项 `missing` | 源未确证累计还是单季，不能将请求中的“累计”当源事实 |
| 20 日波动率、20 日价格变化、总市值 | 各 12 项 `missing` | 未接入，不跨源拼凑或推测 |

这是固定历史快照，不是实时行情。日期来自响应行或精确指标参数，不用请求日期/抓取时间补齐。业务成功码为 `1`；协议、认证、额度错误明确失败，字段口径不明则缺失。PE TTM > 0、PE TTM ≤ 25、报告期加权 ROE > 10% 的一次筛选为 6 通过/6 排除/0 未知；0 未知只适用于该条件组，不代表所有指标完整或存在收益。映射、预算与限制详见 [IFIND_DATA.md](IFIND_DATA.md)，安装授权见 [IFIND_INSTALL.md](IFIND_INSTALL.md)。

## 证据状态与时点

每个字段返回 `status`：`ok`、`missing`、`stale` 或 `error`。**公开源/Fuyao 的时效检查与 iFinD 固定历史日期检查不同**：前者使用运行时 `Date.now()` 比较适用上游时间，超过 7 个自然日标记 `stale`、未来或无效时间标记 `error`（节假日可能误伤）；后者严格核验固定目标交易日/报告期，不因抓取时间新就变成实时，日期不符保守缺失。

数据失败带字段级说明；缺失、失败、过期、K 线不足均不参与“通过”。`asOf` 只填写源实际提供或 K 线末日，未知为 `null`；快照级最大日期不代表所有指标同步。`fetchedAt` 只是本次请求时间，不冒充上游更新时间。

公开源/Fuyao 的现有探测命令（访问网络，执行前确认范围与额度）：

```bash
node scripts/probe-data.mjs
```

该脚本不是 iFinD 全量验证脚本。最新 `npm test` 75/75 和 `npm run test:e2e` 5/5 为合成/mock 自动化回归，与本页 live 观测分离，见 [TESTING.md](TESTING.md)。网络源会变化，单次成功不是稳定性或实时行情承诺。

查询授权不等于公开展示或再分发许可，真实受限响应不入仓库/公共 fixture。GitHub 与 Railway 账号已具备，但本工具未获操作授权，尚未 push 或公网部署；公开演示默认合成数据，真实模式须在部署后另验条款、额度与外网链路。未做用户访谈，也无增长或收益验证。
