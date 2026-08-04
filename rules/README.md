# VERIDIA 内置规则

`default-rules.json` 是安装包中的离线保底规则快照。它不包含凭证、审核内容、Excel、Cookie、数据库或日志。

`npm run rules:publish` 默认验证并使用该项目快照生成远程规则包，不会扫描本机 VERIDIA 数据目录。只有明确设置 `VERIDIA_RULE_DATABASE_PATH` 时，才会从指定 SQLite 数据库发布规则；项目快照缺失或无效时会停止发布并提示补充规则源。

普通客户端只读取公开 GitHub 规则仓库的 Release 资产。发布私钥、GitHub Token 和开发者登录状态不得放入本目录或安装包。
