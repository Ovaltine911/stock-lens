# 公网部署与验证记录

验证日期：2026-11-08。

## 部署

- 产品地址：https://stock-lens-production-9620.up.railway.app
- 源码仓库：https://github.com/Ovaltine911/stock-lens
- 部署代码提交：`e807565a4b6a2eed598a0ac0228a617f720a8447`。
- Railway部署状态：`SUCCESS`；2026-11-08T09:25:39.899Z创建。
- 单实例Node22 Alpine容器，监听平台端口，HTTPS入口。
- 上传来自`git archive HEAD`的47个已提交文件，不包含`.local`、`.env`、技能配置、GitHub/Railway登录缓存或真实金融响应。
- 模型、iFinD和评审凭证通过官方CLI标准输入设置为云端变量，不出现在命令参数、源码、构建上下文或本文中。
- 页面与业务接口需评审登录；仅健康检查可匿名访问，返回配置布尔状态，不含金融数据和凭证。
- 源码仓库创建时为私有，候选人已明确同意公开；公开内容仅为已扫描的源码、文档与合成测试样本，不包含API凭证、评审口令或真实金融响应。

## 公网API验证

在本机通过公网HTTPS请求已部署服务，不是调用本地4173端口。

```text
ANONYMOUS_PAGE_HTTP=401
/ HTTP=200 duration_ms=241
/api/interpret HTTP=200 duration_ms=4981
LIVE_MODEL_MODE=llm
CONDITION_COUNT=3
/api/snapshot HTTP=200 duration_ms=33564
EVIDENCE_COUNTS={"pe_ttm:ok":12,"pb_mrq:ok":12,"revenue_yoy:missing":12,"profit_yoy:missing":12,"roe:ok":12,"volatility_20d:missing":12,"return_20d:missing":12,"market_cap:missing":12}
/api/screen HTTP=200 duration_ms=611
LIVE_SCREEN_COUNTS={"pass":6,"fail":6,"unknown":0,"total":12}
/api/screen HTTP=200 duration_ms=231
DIFF_COUNTS={"added":1,"removed":0}
/api/screen HTTP=422 duration_ms=248
/.local/model.json HTTP=404
/.env HTTP=404
/lib/llm.mjs HTTP=404
PRODUCTION_API_VERIFICATION=PASS
```

解析输入：`市盈率大于0且市盈率不高于25，净资产收益率大于10%`。同快照将PE上限改为40后新增1只；这是规则结果差异，不是投资建议或收益预测。矛盾条件PE<10且PE>30返回422。直接买入/必涨请求返回blocked而不生成建议。

每项耗时是单次观测，不能据此宣称平均延迟或P95。外部依赖、额度和网络波动仍可能导致失败；程序应明确报错而非生成正常结论。

## 公网真实浏览器

使用干净Chromium浏览器上下文和评审认证访问公网，依次完成iFinD真实取数、DeepSeek真实解析、确认筛选、逐字段证据、保存和恢复历史记录；手机390px窄屏检查无横向溢出、系统深色生效。

```text
PROD_BROWSER_AUTH=PASS
PROD_UI_IFIND_SNAPSHOT=PASS
PROD_UI_SCREEN_COUNTS={"pass":6,"fail":6,"unknown":0,"total":12}
PROD_UI_EVIDENCE_AND_SAVE=PASS
PROD_BROWSER_ERRORS=0
PRODUCTION_BROWSER_VERIFICATION=PASS
```

本机此前的79单元/接口+5浏览器测试使用mock/构造数据，与上述有额度消耗的真实公网验证分开记录。

## 试用与预算限制

部署前Railway实际返回免费试用状态、5美元剩余额度、30天剩余试用期、未绑定付款方式。未升级套餐或添加付款方式。此为当时账户状态，不代表永久免费或保证服务可用30天；额度先耗尽时可能停止。

试图设置5美元硬限额未成功：邮件提醒最低5美元、硬限额最低10美元，或0表示关闭。没有将硬限额擅自提高到10美元，没有宣称已设5美元保护。预算监控依赖账户当前试用余额；建议候选人在评审期关注余额。

## 已遇到但已解释的问题

1. 浏览器登录回调超过5分钟后关闭，导致127.0.0.1拒绝连接；改用官方设备授权完成，没有关闭防火墙。
2. 构建中的首次公网访问返回404 Application not found；部署成功后同地址健康和主链路通过。
3. `railway.toml`提示弃用，但工具明确现有配置可用至2026-12-01；当前部署已成功，长期迭代需迁移，不应夸大成永久无维护。
4. 若干CLI帮助查询使用旧子命令名，工具拒绝后依照本机help纠正，不影响已验证数据。

## 剩余边界

固定日期金融快照：估值2026-11-06、报告期2026-09-30，不是实时或公告日期。未核验的累计同比/其他指标继续missing。访问控制不授予数据再分发权，候选人需确认iFinD权益覆盖向评委展示；真实原始响应未放仓库或提交包。没有收益验证、真实用户访谈、高并发或长期稳定性保证。候选人本人仍应走查产品并确认提交内容。
