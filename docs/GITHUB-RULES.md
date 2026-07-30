# VERIDIA GitHub 规则同步

## 架构边界

- 软件更新仓库：现有 `jd-pages/veridia`，仅用于 Electron 安装包和 `latest.yml`。
- 规则更新仓库：由维护者另行创建的独立公开仓库，仅用于规则 Release。
- 客户端只匿名读取 GitHub Release，不登录 GitHub、不保存 GitHub Token，也不具备发布权限。
- SQLite、审核内容、Excel、Cookie、小红书会话、日志、本机路径和使用统计不会上传。
- 运行时认证模式固定为 `LOCAL`。

## 规则仓库配置

独立规则仓库创建后，将实际的 `owner/repository` 写入：

`rules/config.json`

不要在仓库名确定前填写示例地址。规则仓库必须允许匿名下载 Release 资产；Private 仓库不能把 Token 内置到客户端。

## 签名密钥

规则清单使用 Ed25519 分离签名：

1. 私钥只保存在开发者电脑项目目录之外，并通过 `VERIDIA_RULES_SIGNING_KEY_PATH` 指定。
2. 公钥保存为 `rules/public-key.pem`，随客户端发布。
3. 私钥、GitHub Token、`gh` 登录凭证不得提交或打入安装包。

可使用 OpenSSL 在开发者电脑生成：

```powershell
openssl genpkey -algorithm ED25519 -out D:\VERIDIA-Secrets\veridia-rules-private.pem
openssl pkey -in D:\VERIDIA-Secrets\veridia-rules-private.pem -pubout -out rules\public-key.pem
```

## Release 文件

每个规则 Release 使用 `rules-YYYY.MM.DD.N` Tag，并包含：

- `manifest.json`
- `veridia-rules-rules-YYYY.MM.DD.N.zip`
- `manifest.sig`

ZIP 内固定包含 `rules.json`。清单记录 Schema 版本、最低软件版本、文件大小、SHA-256 和四类规则数量。客户端先验证清单签名，再验证 ZIP 大小与 SHA-256。

## 开发者发布

开发电脑需安装并登录 GitHub CLI：

```powershell
gh auth login
$env:VERIDIA_RULES_REPOSITORY="实际owner/实际仓库"
$env:VERIDIA_RULES_SIGNING_KEY_PATH="D:\VERIDIA-Secrets\veridia-rules-private.pem"
```

然后双击 `发布规则新版.bat`。脚本会：

1. 从本地 SQLite 导出产品、活动、阶段组、正文段位词与话题规则；
2. 校验空字段、重复键、话题格式和关联完整性；
3. 生成当天递增的规则版本；
4. 生成 ZIP、清单、SHA-256 和 Ed25519 签名；
5. 先创建 GitHub Draft Release；
6. 下载远程资产复核大小与 SHA-256；
7. 复核成功后才转为正式 Latest Release。

任一步骤失败时，新 Release 保持草稿或不创建，上一版正式规则不会被覆盖。

## 客户端同步

- 每次软件启动后后台检查一次；
- 同一天自动检查最多一次；
- 可在“系统设置 > 规则同步”手动检查或立即同步；
- 下载到临时目录后依次校验大小、SHA-256、签名、Schema 和最低软件版本；
- 应用前在本地数据库保存上一版规则包；
- 使用 SQLite 事务导入并切换版本；
- 失败时事务回滚并继续使用旧规则；
- 新规则不重算历史结果，主动重新审核时才使用当前规则。
