import { describe, expect, it } from "vitest";
import { countEffectiveBodyCharacters, evaluateAudit } from "@/lib/audit-engine";
import { boundaryContext, boundaryNote, plainBoundaryTopic, topicBoundaryChannels } from "../helpers/audit-topic-boundary-fixture";

describe("EFFECTIVE_BODY_EXCLUDES_ALL_HASHTAGS", () => {
  it("跨平台真实正文 20/21 字边界排除全部话题且不提升普通 hashtag 身份", () => {
    for (const channel of topicBoundaryChannels) {
      for (const length of [20, 21]) {
        const plain = [plainBoundaryTopic("#中文普通话题"), plainBoundaryTopic("#abcdefghijklmnopqrstuvwxyz")];
        const note = boundaryNote(channel, {
          body: `${"真".repeat(length)} #required#中文普通话题#abcdefghijklmnopqrstuvwxyz https://example.com/long-url\n，。！？ 😀`,
          textHashtagCandidates: [plain[0]], bodyTextHashtagCandidates: [plain[1]],
        });
        const result = evaluateAudit(note, boundaryContext(channel));
        expect(result, channel).toMatchObject({ effectiveBodyLength: length,
          bodyCompliant: length === 21, topicsCompliant: true, clickableCompliant: true,
          autoStatus: length === 21 ? "PASSED" : "FAILED" });
        const plainRequired = evaluateAudit(note, boundaryContext(channel, {
          rules: [{ ...boundaryContext(channel).rules[0], topic: "#中文普通话题" }],
        }));
        expect(plainRequired.missingTopics, channel).toContain("#中文普通话题");
        expect(plainRequired.topicsCompliant, channel).toBe(false);
        expect(plainRequired.autoStatus, channel).toBe("FAILED");
      }
    }
  });

  it.each([
    { body: "a #required #abcdefghijklmnopqrstuvwxyz", topics: ["#required"], length: 1 },
    { body: "a#中文#EnglishTag＃第二个中文 https://example.com/path?x=123", topics: ["#required"], length: 1 },
    { body: "a #requiredLong #中文话题扩展", topics: ["#required", "#中文话题", "#中文话题扩展"], length: 1 },
    { body: "a #普通中文 hashtag 之外的正文", topics: [], length: 13 },
    { body: "正文 #topic，后文", topics: ["#required"], length: 4 },
    { body: "#中文 #english ＃全角话题 #🌸花朵 https://example.com 😀 ，。！？", topics: [], length: 0 },
    { body: "a #hello world #活动&体验", topics: ["#hello world", "#活动&体验"], length: 1 },
  ])("所有 hashtag 与 URL 从有效字符中扣除：$body", ({ body, topics, length }) => {
    expect(countEffectiveBodyCharacters(body, topics)).toBe(length);
  });

  it("Douyin bodyText 候选的原始文本和更长中文话题优先扣除", () => {
    const note = boundaryNote("DOUYIN", {
      body: "a #中文话题扩展 #hello world",
      topics: [plainBoundaryTopic("#中文话题")], verifiedDouyinTopics: [],
      bodyTextHashtagCandidates: [plainBoundaryTopic("#中文话题扩展"), plainBoundaryTopic("#helloworld", "#hello world")],
    });
    const result = evaluateAudit(note, boundaryContext("DOUYIN"));
    expect(result.effectiveBodyLength).toBe(1);
    expect(result.missingTopics).toEqual(["#required"]);
    expect(result.autoStatus).toBe("FAILED");
  });

  it("未列入候选的普通 hashtag 在已有 verified 话题时仍不计字数", () => {
    for (const channel of topicBoundaryChannels) {
      const result = evaluateAudit(boundaryNote(channel, {
        body: "a #required #abcdefghijklmnopqrstuvwxyz #普通中文话题",
      }), boundaryContext(channel));
      expect(result.effectiveBodyLength, channel).toBe(1);
      expect(result.autoStatus, channel).toBe("FAILED");
    }
  });
});
