# VERIDIA 中央兼容基础

本目录仅保存第一阶段的接口与数据模型草案。

- 当前客户端认证模式实际固定为 `LOCAL`。
- 客户端没有中央服务地址，也不会发起中央账号、规则或统计请求。
- `openapi.yaml` 是第二、三阶段使用的契约草案。
- `control-plane.postgresql.sql` 是独立中央控制面的 PostgreSQL 模型草案，不是本地 SQLite 迁移。
- 允许同步的数据必须经过 `lib/central/privacy.ts` 中的显式白名单选择。

中央控制面不得接收笔记正文、链接、话题证据、Excel、Cookie、Token、浏览器会话、本地数据库、完整日志或本机路径。
