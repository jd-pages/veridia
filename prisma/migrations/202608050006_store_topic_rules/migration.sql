-- Independent, maintainable store-topic rules. Existing audit data is retained.
CREATE TABLE "store_topic_rules" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "commercePlatform" TEXT NOT NULL,
  "storeName" TEXT NOT NULL,
  "normalizedStoreName" TEXT NOT NULL,
  "expectedTopic" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" DATETIME,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "store_topic_rules_commercePlatform_normalizedStoreName_key"
  ON "store_topic_rules"("commercePlatform", "normalizedStoreName");
CREATE INDEX "store_topic_rules_commercePlatform_enabled_deletedAt_idx"
  ON "store_topic_rules"("commercePlatform", "enabled", "deletedAt");
CREATE INDEX "store_topic_rules_updatedAt_idx" ON "store_topic_rules"("updatedAt");

ALTER TABLE "audit_tasks" ADD COLUMN "storeTopicRuleId" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "matchedStoreName" TEXT;
CREATE INDEX "audit_tasks_storeTopicRuleId_idx" ON "audit_tasks"("storeTopicRuleId");

-- Idempotent migration of the former built-in list. ASCII letters alone are lower-cased.
INSERT OR IGNORE INTO "store_topic_rules"
  ("id", "commercePlatform", "storeName", "normalizedStoreName", "expectedTopic", "enabled", "createdAt", "updatedAt")
VALUES
  ('store-topic-jd-01','JD','爱他美优选海外专卖店','爱他美优选海外专卖店','#爱他美优选海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-02','JD','爱他美国际进口超市','爱他美国际进口超市','#爱他美国际进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-03','JD','Aptamil爱他美海外进口超市','aptamil爱他美海外进口超市','#Aptamil爱他美海外进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-04','JD','爱他美精选海外专卖店','爱他美精选海外专卖店','#爱他美精选海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-05','JD','爱他美海外京东自营专区','爱他美海外京东自营专区','#爱他美海外京东自营专区',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-06','JD','FOLO海外官方旗舰店','folo海外官方旗舰店','#FOLO海外官方旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-07','JD','国际平价会员店','国际平价会员店','#国际平价会员店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-08','JD','环球甄选旗舰店','环球甄选旗舰店','#环球甄选旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-09','JD','海星健康官方进口超市','海星健康官方进口超市','#海星健康官方进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-10','JD','京东全球购母婴直营店','京东全球购母婴直营店','#京东全球购母婴直营店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-11','JD','佳贝艾特(Kabrita)海外专卖店','佳贝艾特(kabrita)海外专卖店','#佳贝艾特(Kabrita)海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-12','JD','佳贝艾特海外京东自营旗舰店','佳贝艾特海外京东自营旗舰店','#佳贝艾特海外京东自营旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-13','JD','佳贝艾特官方海外旗舰店','佳贝艾特官方海外旗舰店','#佳贝艾特官方海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-14','JD','佳贝艾特(Kabrita)海外旗舰店','佳贝艾特(kabrita)海外旗舰店','#佳贝艾特(Kabrita)海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-15','JD','a2海外专卖店','a2海外专卖店','#a2海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-16','JD','美素佳儿海外专卖店','美素佳儿海外专卖店','#美素佳儿海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-17','JD','雀巢母婴海外专卖店','雀巢母婴海外专卖店','#雀巢母婴海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-18','JD','贝拉米海外专卖店','贝拉米海外专卖店','#贝拉米海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-19','JD','惠氏(Wyeth)海外专卖店','惠氏(wyeth)海外专卖店','#惠氏(Wyeth)海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-20','JD','健康官方进口超市','健康官方进口超市','#健康官方进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-21','JD','京东健康官方进口超市','京东健康官方进口超市','#京东健康官方进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-22','JD','荷兰官方进口国家馆','荷兰官方进口国家馆','#荷兰官方进口国家馆',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-23','JD','德国官方进口国家馆','德国官方进口国家馆','#德国官方进口国家馆',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-24','JD','澳大利亚官方进口国家馆','澳大利亚官方进口国家馆','#澳大利亚官方进口国家馆',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-25','JD','医学营养京东自营旗舰店','医学营养京东自营旗舰店','#医学营养京东自营旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-26','JD','京东健康海外自营旗舰店','京东健康海外自营旗舰店','#京东健康海外自营旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-jd-27','JD','京东健康全球探物','京东健康全球探物','#京东健康全球探物',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-douyin_ecommerce-01','DOUYIN_ECOMMERCE','ROCKCHECK海外专营店','rockcheck海外专营店','#ROCKCHECK海外专营店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-douyin_ecommerce-02','DOUYIN_ECOMMERCE','FOLO海外旗舰店','folo海外旗舰店','#FOLO海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-douyin_ecommerce-03','DOUYIN_ECOMMERCE','佳贝艾特kabrita海外旗舰店','佳贝艾特kabrita海外旗舰店','#佳贝艾特kabrita海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-douyin_ecommerce-04','DOUYIN_ECOMMERCE','Bellamy''s贝拉米荣程海外专卖店','bellamy''s贝拉米荣程海外专卖店','#Bellamy''s贝拉米荣程海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-01','TMALL','folo海外专营店','folo海外专营店','#folo海外专营店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-02','TMALL','AYW海外专营店','ayw海外专营店','#AYW海外专营店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-03','TMALL','BJF海外专营店','bjf海外专营店','#BJF海外专营店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-04','TMALL','贝拉米海星海外专卖店','贝拉米海星海外专卖店','#贝拉米海星海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-05','TMALL','kabrita海外旗舰店','kabrita海外旗舰店','#kabrita海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-06','TMALL','kabrita母婴海外旗舰店','kabrita母婴海外旗舰店','#kabrita母婴海外旗舰店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-07','TMALL','a2金胜海外专卖店','a2金胜海外专卖店','#a2金胜海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-08','TMALL','a2海星海外专卖店','a2海星海外专卖店','#a2海星海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-tmall-09','TMALL','爱他美金胜海外专卖店','爱他美金胜海外专卖店','#爱他美金胜海外专卖店',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-taobao-01','TAOBAO','ALG阿莱购','alg阿莱购','#ALG阿莱购',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('store-topic-taobao-02','TAOBAO','国际进口超市','国际进口超市','#国际进口超市',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
