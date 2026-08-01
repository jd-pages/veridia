import { describe, expect, it } from "vitest";
import {
  collectJsonCandidates,
  mergeCandidates,
  noteIdCandidatesFromUrls,
  safeEvidenceUrl,
} from "@/lib/automation/xhs-page-evidence";

describe("小红书自动取证候选解析", () => {
  it("从 discovery、explore 和 target_note_id 中识别笔记 ID", () => {
    const candidates = noteIdCandidatesFromUrls([
      "https://www.xiaohongshu.com/discovery/item/6a5cb375000000000301c549",
      "https://www.xiaohongshu.com/explore/6a5cb375000000000301c550",
      "https://www.xiaohongshu.com/explore?target_note_id=6a5cb375000000000301c551",
    ]);
    expect(candidates.map((item) => item.value)).toEqual([
      "6a5cb375000000000301c549",
      "6a5cb375000000000301c550",
      "6a5cb375000000000301c551",
    ]);
  });

  it("从当前 feed JSON 中提取正文、话题和按图片项去重的候选", () => {
    const candidates = collectJsonCandidates(
      {
        data: {
          items: [
            {
              id: "6a5cb375000000000301c549",
              note_card: {
                title: "奶粉体验记录",
                desc: "正文内容 #新生儿奶粉 #爱他美新手爸妈日记",
                tag_list: [
                  { name: "新生儿奶粉", url: "/search_result?keyword=新生儿奶粉" },
                ],
                image_list: [
                  { url_default: "https://ci.example.com/1.jpg?token=secret" },
                  { url_default: "https://ci.example.com/2.jpg?token=secret" },
                ],
              },
            },
          ],
        },
      },
      "NETWORK_JSON",
    );
    expect(candidates.noteIdCandidates[0]?.value).toBe(
      "6a5cb375000000000301c549",
    );
    expect(candidates.bodyCandidates[0]?.value).toContain("正文内容");
    expect(candidates.topicCandidates.map((item) => item.displayText)).toEqual(
      expect.arrayContaining(["#新生儿奶粉", "#爱他美新手爸妈日记"]),
    );
    expect(candidates.imageCandidates).toHaveLength(2);
    expect(candidates.imageCandidates[0]?.url).not.toContain("secret");
  });

  it("DOM 文本候选和可点击候选合并时优先保留可点击证据", () => {
    const text = collectJsonCandidates(
      { description: "正文 #新生儿奶粉" },
      "PAGE_JSON",
    );
    const link = collectJsonCandidates(
      {
        tag_list: [
          { name: "新生儿奶粉", url: "https://www.xiaohongshu.com/search_result?keyword=1" },
        ],
      },
      "NETWORK_JSON",
    );
    const merged = mergeCandidates(text, link);
    const topic = merged.topicCandidates.find(
      (item) => item.displayText === "#新生儿奶粉",
    );
    expect(topic?.isLinkElement).toBe(true);
    expect(topic?.hasHref).toBe(true);
  });

  it("页面证据 URL 会遮蔽查询令牌", () => {
    const value = safeEvidenceUrl(
      "https://www.xiaohongshu.com/explore/abc?xsec_token=secret&source=share",
    );
    expect(value).not.toContain("secret");
    expect(value).toContain("source=share");
  });
});
