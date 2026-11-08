# 扶摇真实权限与字段探测

日期：2026-11-08。用户在本机安全配置页保存密钥，官方单股估值端点成功后，再进行4次受控真实探测。没有输出或提交密钥；原始响应只在会话私有临时目录，不在仓库。此记录不是生产接口集成完成报告。

## 认证与保存

```text
SETUP_HTTP=200
FUYAO_KEY_CONFIGURED=true
FUYAO_VALIDATION: http=200 business_code=0 checked_endpoint=valuations/snapshot
PROVIDER_SETUP_SAVED: provider=扶摇 credential_redacted=true
FUYAO_SETUP_PORT_CLOSED=true
```

只关闭已使用完的配置入口，不影响产品服务或保存的配置。

## 4次真实探测

| 用途 | 接口 | 参数范围 | 结果 | 单次耗时 |
| --- | --- | --- | --- | --- |
| 交易日历 | `/api/a-share/calendar/trading-days` | 20260901至20261108 | HTTP200，code0，43个交易日，最后20261106 | 127ms |
| 财务指标 | `/api/a-share/financials/indicators` | 600519.SH，report=2026-3 | HTTP200，code0，返回5组能力与多个指标项 | 53ms |
| 历史日线 | `/api/a-share/prices/historical-batch` | 600519.SH和000858.SZ，2026-09-01至2026-11-08，1d，forward | HTTP200，code0，各43根日线 | 85ms |
| 年度利润表 | `/api/a-share/financials/income-statements-batch` | 同上两只，period=annual，limit=2 | HTTP200，code0，各2025与2024年度数据 | 64ms |

```text
REQUEST_COUNT=4
SUCCESS_COUNT=4
API_CREDENTIAL_PRINTED=false
```

少量单次请求耗时不是全市场性能、生产延迟SLA或与iFinD公平对照实验。

## 字段与日期核验

1. K线元信息实际返回 `interval=1d, adjust=forward`；每只股票43根，收盘价均为正，日期集合与上述交易日历完全匹配。实际日期字段为 `date_ms`，应按上海时区显示2026-09-01至2026-11-06；UTC日期会落在前一日16:00，不能直接截UTC年月日作为交易日。
2. 财务指标实际返回 `report=2026-3`，包含 `calculate_operating_income_yoy_growth_ratio`、`calculate_parent_holder_net_profit_yoy_growth_ratio`、`index_weighted_avg_roe` 等非空值。仍需确认比例单位及累计/单季度语义，不能仅凭字段存在就映射到当前累计同比条件。
3. 年度利润表包含 `period=annual`、`fiscal_year`、`period_end_ms`、`report_date_ms`、`currency=CNY`、`operating_income`和`parent_holder_net_profit`。两年原值可支持按同口径定义年度增长指标的后续实现，但年度同比不能冒充最近季度同比。
4. 两个年度行的 `report_date_ms` 存在同一股票相同的情况，可能是后续披露或调整口径；本次未证明其为每年度首次公告日期，不能据此构造历史时点可得性或无前视偏差回测。
5. 本次只查询两只股票（指标端点只查一只），不能推广为12只或全市场所有字段都可用。

## 对产品简化的意义

数据能力足以支持进一步实现“后台自动取数、按字段路由”，而不是让终端用户选择供应商和手动加载。预期优先：扶摇K线和交易日历支持波动率；财务字段验证后补足经营指标；iFinD保留已核验PE/PB/加权ROE或专业查询能力。双源并不要求每次全部调用，同字段有重叠时按明确口径与时效选源，不能任意选有利数值。

## 尚未做

- 未将扶摇凭证同步到云端，线上仍保持已交付版本。
- 未实现或部署“取消选源、自动取数、仅歧义确认”的新交互。
- 未完成累计财务口径、字段单位、全部12股票字段覆盖与缓存策略的实现验证。
- 未做新版本全量并发、全市场和长期稳定性测试。

官方依据：https://fuyao.aicubes.cn/docs/api-reference/financial-indicators/ 、https://fuyao.aicubes.cn/docs/api-reference/prices/ 、https://fuyao.aicubes.cn/docs/api-reference/calendar/ 、https://fuyao.aicubes.cn/docs/api-reference/financials/ 。
