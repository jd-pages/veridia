# VERIDIA Manual Release Smoke Checklist

按本次 Change Impact Map 选择受影响组；共享核心模块变更必须覆盖该组全部真实样本，不要求每版无差别重跑全部人工样本。每项记录版本、样本、时间和证据。

## XHS_REGRESSION_ALL

- [ ] XHS 404 / `errorCode=-510001`：结论为笔记不存在，不执行普通内容审核
- [ ] 普通图文：标题、正文、图片、话题、平台时间、公开状态正确
- [ ] Live Photo：IMAGE_TEXT、图片数量正确、不误判视频
- [ ] 0 互动：0/0/0，总数 0
- [ ] 高互动：8/4/10，总数 22

## STORE_MAPPING_AND_TOPIC_ALL

- [ ] Kabrita：Store Mapping=MATCHED、Store Topic=NOT_REQUIRED、PRODUCT_STAGE=NONE

## DUPLICATE / IMPORT

- [ ] 删除 Result 后重新导入：duplicate occupancy 已释放
- [ ] Bulk duplicate：单条、多选、全部确认有效且不绕过其他预检错误
- [ ] Import delete：Batch/Task/Result 联动删除，同名其他 Import 不受影响

## TEMPLATE_ISOLATION_ALL

- [ ] Danone 模板：阶段 IFFO/GUM，段位 P/1/2/3/4/1+/2+，反向输入失败
- [ ] Kabrita 模板：仍按独立格式解析，不受 Danone 语义影响

## AUTOMATION_RUNNER_LIFECYCLE_ALL

- [ ] PROCESSING 中 PAUSE 后立即 CONTINUE：有限时间重新 RUNNING、旧结果写入被拒绝、后续 Batch 不饥饿
