import type { CommercePlatform } from "@/lib/result-source";

export interface StoreTopicRuleSeed {
  id: string;
  commercePlatform: CommercePlatform;
  storeName: string;
}

export interface StoreRequiredTopicSeed {
  commercePlatform: CommercePlatform;
  storeName: string;
  topic: string;
}

export interface StoreAcceptedTopicSeed {
  commercePlatform: CommercePlatform;
  storeName: string;
  topic: string;
  isStoreAlias?: boolean;
}

const storesByPlatform: Record<CommercePlatform, readonly string[]> = {
  JD: [
    "Aptamil爱他美海外优选进口超市", "爱他美国际进口超市", "Aptamil爱他美海外进口超市",
    "爱他美精选海外专卖店", "爱他美海外京东自营专区", "FOLO海外官方旗舰店",
    "国际平价会员店", "环球甄选旗舰店", "海星健康官方进口超市",
    "京东全球购母婴直营店", "佳贝艾特(Kabrita)海外专卖店",
    "佳贝艾特海外京东自营旗舰店", "佳贝艾特官方海外旗舰店",
    "佳贝艾特(Kabrita)海外旗舰店", "a2海外专卖店", "美素佳儿海外专卖店",
    "雀巢母婴海外专卖店", "贝拉米海外专卖店", "惠氏(Wyeth)海外专卖店",
    "健康官方进口超市", "京东健康官方进口超市", "荷兰官方进口国家馆",
    "德国官方进口国家馆", "澳大利亚官方进口国家馆", "医学营养京东自营旗舰店",
    "京东健康海外自营旗舰店", "京东健康全球探物",
  ],
  DOUYIN_ECOMMERCE: [
    "ROCKCHECK海外专营店", "FOLO海外旗舰店", "佳贝艾特kabrita海外旗舰店",
    "Bellamy's贝拉米荣程海外专卖店",
  ],
  TMALL: [
    "folo海外专营店", "AYW海外专营店", "BJF海外专营店", "贝拉米海星海外专卖店",
    "kabrita海外旗舰店", "kabrita母婴海外旗舰店", "a2金胜海外专卖店",
    "a2海星海外专卖店", "爱他美金胜海外专卖店",
  ],
  TAOBAO: ["ALG阿莱购", "国际进口超市"],
};

export const storeTopicRuleSeeds: readonly StoreTopicRuleSeed[] = Object.entries(
  storesByPlatform,
).flatMap(([commercePlatform, stores]) =>
  stores.map((storeName, index) => ({
    id: `store-topic-${commercePlatform.toLowerCase()}-${String(index + 1).padStart(2, "0")}`,
    commercePlatform: commercePlatform as CommercePlatform,
    storeName,
  })),
);

export const storeAcceptedTopicSeeds: readonly StoreAcceptedTopicSeed[] = [
  {
    commercePlatform: "JD",
    storeName: "Aptamil爱他美海外优选进口超市",
    topic: "#爱他美优选海外专卖店",
    isStoreAlias: true,
  },
  {
    commercePlatform: "DOUYIN_ECOMMERCE",
    storeName: "ROCKCHECK海外专营店",
    topic: "#爱他美RC奶粉直播间",
  },
];

const jdStoresRequiringPlatformTopic = [
  "健康官方进口超市",
  "Aptamil爱他美海外优选进口超市",
  "Aptamil爱他美海外进口超市",
  "爱他美国际进口超市",
  "FOLO海外官方旗舰店",
  "国际平价会员店",
  "爱他美精选海外专卖店",
  "澳大利亚官方进口国家馆",
  "德国官方进口国家馆",
  "海星健康官方进口超市",
  "荷兰官方进口国家馆",
  "环球甄选旗舰店",
] as const;

const tmallStoresRequiringPlatformTopic = [
  "爱他美金胜海外专卖店",
  "AYW海外专营店",
  "folo海外专营店",
  "BJF海外专营店",
] as const;

const taobaoStoresRequiringPlatformTopic = [
  "国际进口超市",
  "ALG阿莱购",
] as const;

export const storeRequiredTopicSeeds: readonly StoreRequiredTopicSeed[] = [
  ...jdStoresRequiringPlatformTopic.map((storeName) => ({
    commercePlatform: "JD" as const,
    storeName,
    topic: "#京东",
  })),
  ...tmallStoresRequiringPlatformTopic.map((storeName) => ({
    commercePlatform: "TMALL" as const,
    storeName,
    topic: "#天猫",
  })),
  ...taobaoStoresRequiringPlatformTopic.map((storeName) => ({
    commercePlatform: "TAOBAO" as const,
    storeName,
    topic: "#淘宝",
  })),
];
