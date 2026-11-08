# iFinD 工作区级安装与验证记录

## 范围与版本

- 候选人本人已完成 iFinD 注册，并授权仅当前“秋招面试”工作区安装与查询；安装操作、适配实现和代码修复由 AI 执行，不写成候选人亲自编程。
- 安装目录（相对工作区）：`.picode/skills/ifind-finance-data/`。
- 官方包版本：1.5.1。
- 安装指南：https://mcp.51ifind.com/gwstatic/static/ds_web/ifind-mcp-web/skills/SKILL_INSTALL_GUIDE.md
- 下载地址：https://s.thsi.cn/cd/ifind-java-ds-bff-web-container/ifind-mcp-web/skills/ifind-finance-data-1.5.1.zip
- 文件大小：31773 bytes。
- 包 SHA-256：`9a3526fcae236b9b8e021f8757c5e73fd9e0d82bfa8395154096f6aba85ba805`。用于本次下载完整性记录，不等于发布者签名验证。
- Node.js：v20.18.0；Python：3.9.6（未用于请求）。

## 结构差异

旧安装指南把调用脚本和配置写在根目录；实际1.5.1官方包使用：

```text
SKILL.md
scripts/call-node.js
scripts/call.py
config/mcp_config.json
config/skill_env_config.json
references/
```

遵循实际文件结构，没有修改官方调用代码。SKILL.md及两个调用脚本与下载包的内容哈希一致。

## 凭证处理

真实密钥仅保存在技能目录的 `config/mcp_config.json`，文件权限0600，配置目录0700。只允许当前系统用户读写配置文件。未复制到产品前端、源码或交付材料。工作区根 `.gitignore` 排除 `**/mcp_config.json`，产品打包必须使用白名单而非整个工作区压缩。

`config/skill_env_config.json` 的 `agent_name` 为 PiCode，按官方说明作为User-Agent发送。没有修改全局技能、全局MCP、安全权限或其他工作区配置。

用户曾将密钥发送到聊天；不能据此宣称没有任何日志暴露风险。建议在集成验证后由用户在iFinD后台轮换，后续直接在本机配置新密钥，不再次粘贴到聊天。

## 真实可用性自检

时间：2026-11-08。

通过临时CommonJS脚本导入 `scripts/call-node.js` 后调用 `listTools('stock')`，不是直接执行函数库。密钥验证非空、非占位符、无首尾空白；结果仅输出布尔状态、HTTP状态、工具数量和名称，没有输出密钥或会话ID。自检完成后临时脚本已删除。

实测日志：

```text
KEY_CONFIGURED=true
CONFIG_PERMISSION=0o600
SELFCHECK_RESULT: {"ok":true,"status_code":200,"tool_count":10,"tool_names":["get_stock_summary","search_stocks","get_stock_performance","get_stock_info","get_stock_shareholders","get_stock_financials","get_risk_indicators","get_stock_events","get_esg_data","stock_highfreq_quotes"]}
CREDENTIAL_PRINTED=false
OFFICIAL_FILES_UNCHANGED True
TEMP_SELFCHECK_REMOVED True
```

安装自检结论：官方客户端可使用当前配置连接股票服务并获得 10 项工具列表。**工具发现本身不证明业务取数、额度或商业/再分发权**；但后续产品集成已有独立成功证据，不能继续将本项目描述为“只验证过工具列表”。

## 后续已完成的产品验证

最新证据见 [LIVE_VALIDATION.md](LIVE_VALIDATION.md) 和 [IFIND_DATA.md](IFIND_DATA.md)：官方客户端先完成两股四次业务查询，独立产品适配器随后通过显式授权配置完成正式网页 API 的 **12 股、6 次工具请求**，快照 HTTP 200、单次 **25757ms**；PE/ROE 筛选也 HTTP 200。

- PE TTM、PB MRQ、报告期加权 ROE 各 12 项 `ok`；其余 5 类指标各 12 项 `missing`。
- 估值交易日固定 **2026-11-06**；财务报告期固定 **2026-09-30**，不是公告日、可获得日或实时数据。
- 营收/利润同比未确认累计口径，不能因为源返回数值就冒充可用；未接入的波动率、价格变化和市值保持缺失。
- 最新合成/mock 回归为 `npm test` 75/75 与 `npm run test:e2e` 5/5，均 0 失败；与上述 live 请求分开，见 [TESTING.md](TESTING.md)。

## 部署与使用边界

技能用于当前工作区开发取数；产品已有独立适配，不要求公开部署环境安装整个工作区技能。上线需通过平台秘密配置接入，不能硬编码本机路径或复制私有配置；按用户权益限流，再验证公网环境、财务口径与展示授权。

GitHub `Ovaltine911` 身份和 Railway 账号/登录已有，但本工具尚未获操作授权，未 push、未公网部署。安装成功及本机 API 成功不能替代这些交付项，也不能证明长期额度、多账号权益或数据再分发许可。

安装完成不意味着当前会话的技能注册表立即热更新。若宿主尚未列出此技能，需要重新加载工作区/技能列表；不能伪称已通过动态技能调用器加载。
