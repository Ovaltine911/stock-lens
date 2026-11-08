# V3 一句话筛选改版验证记录

## 用户提出的问题与取舍

用户指出旧流程先选数据源、加载、输入、解析、勾选、确认过于繁琐，要求供应商选择由系统处理，且明确委派前端审美子智能体做同花顺风格。

V3目标：明确意图一次提交执行；模糊含义只一次确认；后台自动取数，来源、口径、日期和12家样本范围仍然透明。UI参考金融红、白灰底、紧凑条件和数字表格，不假冒同花顺官方，不添加虚假行情装饰。

## 模型真实分流

2026-11-08，本机独立V3服务：

```text
明确PE/ROE阈值：HTTP200，needsConfirmation=false，3条件，无clarifications，2567ms
经营改善/估值合理/走势相对稳定：HTTP200，needsConfirmation=true，5条件，3条说明，8486ms
```

模糊经营改善采用两个完整年度营收和归母净利润增长，由用户确认年度口径，不冒充最新季度。用户明确季度同比仍用原指标，不自动偷换。

## 自动数据真实本机验证

主源扶摇，12股，正常19请求；每个指标保留来源字段与口径。iFinD只用于缺失的PE/PB/ROE备用，主源满足时不调用。本次仅扶摇即满足主要条件：

```text
AUTO_HTTP=200
AUTO_DURATION_MS=1570
AUTO_COUNT=12
AUTO_EVIDENCE_COUNTS={"pe_ttm":{"ok":12},"pb_mrq":{"ok":12},"revenue_yoy":{"missing":12},"profit_yoy":{"missing":12},"revenue_yoy_annual":{"ok":12},"profit_yoy_annual":{"ok":11,"missing":1},"roe":{"ok":12},"volatility_20d":{"ok":12},"return_20d":{"ok":12},"market_cap":{"missing":12}}
AUTO_PROVIDERS=["同花顺扶摇金融数据 API"]
CACHE_REUSE=true
AUTO_SCREEN_HTTP=200
AUTO_SCREEN_COUNTS={"pass":5,"fail":7,"unknown":0,"total":12}
```

`unknown=0`只对整组条件的最终结论成立；某公司若同时有一个已知失败条件和一个未知条件，整体为失败，未知证据仍保留。

15分钟同进程缓存及并发请求合并减少重复取数，跨上海自然日自动过期；用户改阈值必须在同一个快照上比较。缓存命中不把数据时点改为当前时间。

## 性能结论边界

1.57秒是本机单次测量，不是P95、云端性能承诺或与旧来源严格公平对比。样本仍是12家，不是全市场；财务累计同比与市值未核验，仍缺失。比例单位采用官方百分数值定义，不按数值大小猜倍率。估值元数据时间和最近交易日可能不同，逐字段说明。

## 当前验收状态

基础数据/意图/缓存已验证。本机完整121项单元/接口和8项浏览器用例通过，完整设计检查通过。实际查看了1440px结果页与首页截图；手机390px无横向溢出。

本机真实浏览器：
```text
EXPLICIT_ONE_SUBMIT=PASS
EXPLICIT_TOTAL_MS=3777
EXPLICIT_COUNTS={"pass":6,"fail":6,"unknown":0,"total":12}
FUZZY_SINGLE_CONFIRM=PASS
FUZZY_COUNTS={"pass":5,"fail":7,"unknown":0,"total":12}
BROWSER_ERRORS=0
V3_LIVE_BROWSER=PASS
```

联调发现并处理：历史单条记录直接恢复与测试预期弹窗不一致，测试改为验证历史标识和重新查询按钮；冲突说明补充明确‘冲突’字样；手机不再隐藏数据与口径入口；年度年份提取只接受显式年份/日期字段，防止从时间戳误提年份；已确认的模糊解释折叠并清除待确认文案。

部署和最终打包以随后记录为准。线上旧版在发布新版本前保持不变。
