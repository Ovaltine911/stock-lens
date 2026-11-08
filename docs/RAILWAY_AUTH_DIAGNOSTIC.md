# Railway 登录回调失败诊断

## 现象

2026-11-08，浏览器授权后提示“127.0.0.1 拒绝了我们的连接请求”。本次是部署工具登录失败，不是产品网页的筛选逻辑失败，也不是GitHub推送失败。

## 实际证据

第一轮使用官方 `railway login`，临时回调为本机端口55883。工具等待5分钟后退出，日志：

```text
Authentication timed out — no callback received after 5 minutes
Caused by:
    deadline has elapsed
```

随后独立检查授权状态与端口：

```text
Unauthorized. Please login with `railway login`
CALLBACK_PORT_55883=NOT_ACCEPTING_CONNECTIONS
```

`lsof` 未发现该端口的监听进程。结合工具退出记录，当前浏览器无法连接的直接原因是登录回调监听已结束。尚无证据证明此前回调未到达是防火墙或代理造成，也不据此建议关闭安全防护。

## 处理

改用官方设备授权，不依赖本机HTTP回调：

```diff
- railway login
+ railway login --browserless
```

官方工具生成新的 `https://railway.com/activate` 授权，设备码只写入本机剪贴板，不写本记录、源码或提交材料。需用户在已登录的浏览器确认后，以 `railway whoami` 成功作为授权完成证据。

## 状态边界

生成设备码不等于已授权，已授权不等于已部署。直到身份检查与公网验证完成，不宣称部署成功。
