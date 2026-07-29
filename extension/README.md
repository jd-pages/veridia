# 浏览器插件

1. 在 Chrome/Edge 打开扩展管理页并开启“开发者模式”。
2. 选择“加载已解压的扩展程序”，指向本目录 `extension`。
3. 启动本地审核系统，默认地址为 `http://localhost:3100`。
4. 先在审核任务页创建链接，再打开对应笔记或 `/mock/xhs` 模拟页。
5. 点击插件图标，填写与后端一致的提交令牌，先选择“测试连接”。
6. 连接成功后选择“提取并提交审核”。

健康检查使用 `GET /api/extension/health`，笔记提交使用
`POST /api/extension/submit`。两者都通过 `X-Extension-Token` 请求头校验，
但不会在响应或控制台日志中输出完整令牌。

真实小红书 DOM 选择器集中在 `src/adapters/xiaohongshu.js` 的 `SELECTORS` 常量中维护。不要把选择器复制到规则引擎。
