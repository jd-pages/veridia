import { describe, expect, it } from "vitest";
import {
  validateAcceptedStoreTopics,
  validateStoreTopicGroups,
} from "@/lib/store-topic-rule-service";

describe("可接受店铺话题输入", () => {
  it("新增店铺时生成第一条默认话题并统一补齐井号", () => {
    expect(validateAcceptedStoreTopics(undefined, "ROCKCHECK海外专营店"))
      .toEqual([
        {
          id: undefined,
          topic: "#ROCKCHECK海外专营店",
          normalizedTopic: "rockcheck海外专营店",
          enabled: true,
          topicType: "ACCEPTED",
        },
      ]);
  });

  it("按输入顺序保存两条独立话题，不使用分隔符拆分", () => {
    expect(
      validateAcceptedStoreTopics([
        { topic: "#ROCKCHECK海外专营店" },
        { topic: "ROCKCHECK海外旗舰店" },
      ]).map((item) => item.topic),
    ).toEqual(["#ROCKCHECK海外专营店", "#ROCKCHECK海外旗舰店"]);
    expect(() =>
      validateAcceptedStoreTopics([
        { topic: "ROCKCHECK海外专营店,ROCKCHECK海外旗舰店" },
      ]),
    ).toThrow("只能填写一条完整话题");
  });

  it("拒绝空白、零条及仅英文大小写不同的重复话题", () => {
    expect(() => validateAcceptedStoreTopics([])).toThrow("至少需要配置一条");
    expect(() => validateAcceptedStoreTopics([{ topic: " " }])).toThrow(
      "不能为空",
    );
    expect(() =>
      validateAcceptedStoreTopics([
        { topic: "#FOLO海外专营店" },
        { topic: "#folo海外专营店" },
      ]),
    ).toThrow("该店铺已存在相同话题：#FOLO海外专营店");
  });

  it("内部空格不同仍作为两个精确话题保留", () => {
    expect(
      validateAcceptedStoreTopics([
        { topic: "FOLO海外专营店" },
        { topic: "FOLO 海外专营店" },
      ]),
    ).toHaveLength(2);
  });

  it("附加必需话题允许为空，但不能与可接受话题重复", () => {
    expect(
      validateStoreTopicGroups({
        acceptedTopics: [{ topic: "FOLO海外专营店" }],
        requiredTopics: [],
      }).requiredTopics,
    ).toEqual([]);
    expect(() =>
      validateStoreTopicGroups({
        acceptedTopics: [{ topic: "FOLO海外专营店" }],
        requiredTopics: [{ topic: "folo海外专营店" }],
      }),
    ).toThrow("同一话题不能同时设为可接受和附加必需话题");
  });
});
