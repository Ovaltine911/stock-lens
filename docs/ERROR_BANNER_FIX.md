# 红色错误横幅误显示修正

## 用户反馈与根因

用户在成功筛选结果旁看到“暂时无法完成，请检查连接后重试”。线上健康接口HTTP200；干净浏览器无需触发失败即可复现：

```text
{"id":"errorBox","hidden":true,"display":"flex","visible":true}
{"id":"retryBtn","hidden":true,"display":"flex","visible":true}
```

`public/index.html` 给错误横幅和重试按钮设置了hidden，JS正常清除时也置hidden=true。但组件CSS声明display:flex会覆盖浏览器hidden默认显示规则，导致静态占位错误文案被显示。是前端可见性bug，不是该横幅证明网络故障，也不是股票风险评价。

## 最小修正

在 `public/styles.css` 增加：

```css
[hidden] {
  display: none !important;
}
```

没有删除错误处理或将错误文字永久隐藏；JS需要展示真实失败时将hidden=false，原有布局正常生效。修复同时适用于其他组件的hidden状态。

## 先失败再通过的验证

`tests/browser.e2e.mjs` 新增验证初始隐藏、成功筛选隐藏、真实条件冲突显示、恢复后隐藏的完整用例。修复前运行该测试实际失败：

```text
error: '#errorBox 的 hidden 不能被布局样式覆盖'
expected: false
actual: true
```

修复后完整结果：

```text
npm test: 79 passed, 0 failed
npm run test:e2e: 6 passed, 0 failed
npm run check:design: 全部合规
```

## 测试遗漏说明

此前浏览器验证检查了筛选结果、真实错误出现、保存恢复与页面脚本异常，但没有断言“无错误时横幅不可见”，所以页面脚本零异常和流程通过未发现该问题。用户走查补充了缺失的负向可见性检查，后续纳入回归。

该修复不改变指标、筛选逻辑、来源数据或用户凭证。上线后用户需刷新页面，已在旧页面内运行的DOM不会自动更新。
