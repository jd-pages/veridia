import { describe, expect, it } from "vitest";
import {
  collectJsonCandidates,
  mergeCandidates,
  noteIdCandidatesFromUrls,
  safeEvidenceUrl,
  verifiedTopicsForCurrentNote,
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
                create_time: 1_786_071_651,
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
    expect(
      candidates.textHashtagCandidates.map((item) => item.displayText),
    ).toEqual(
      expect.arrayContaining(["#新生儿奶粉", "#爱他美新手爸妈日记"]),
    );
    expect(
      candidates.verifiedPlatformTopics.map((item) => item.displayText),
    ).toEqual(["#新生儿奶粉"]);
    expect(candidates.verifiedPlatformTopics[0]?.contentId).toBe(
      "6a5cb375000000000301c549",
    );
    expect(candidates.imageCandidates).toHaveLength(2);
    expect(candidates.imageCandidates[0]?.url).not.toContain("secret");
    expect(candidates.publishedAtCandidates).toEqual([
      expect.objectContaining({
        contentId: "6a5cb375000000000301c549",
        raw: expect.stringMatching(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
        source: "NETWORK_JSON:create_time",
      }),
    ]);
  });

  it("多个笔记结构化时间保持各自 noteId 关联，不会取第一条补位", () => {
    const candidates = collectJsonCandidates({
      items: [
        {
          id: "6a5cb375000000000301c541",
          note_card: { create_time: 1_700_000_000 },
        },
        {
          id: "6a5cb375000000000301c542",
          note_card: { create_time: 1_786_071_651 },
        },
      ],
    });
    expect(
      candidates.publishedAtCandidates.map((candidate) => candidate.contentId),
    ).toEqual([
      "6a5cb375000000000301c541",
      "6a5cb375000000000301c542",
    ]);
  });

  it("正文文本候选与结构化平台话题保持分层", () => {
    const text = collectJsonCandidates(
      {
        id: "6a5cb375000000000301c549",
        note_card: { description: "正文 #新生儿奶粉" },
      },
      "PAGE_JSON",
    );
    const link = collectJsonCandidates(
      {
        id: "6a5cb375000000000301c549",
        note_card: {
          tag_list: [
            { name: "新生儿奶粉", url: "https://www.xiaohongshu.com/search_result?keyword=1" },
          ],
        },
      },
      "NETWORK_JSON",
    );
    const merged = mergeCandidates(text, link);
    const textCandidate = merged.textHashtagCandidates.find(
      (item) => item.displayText === "#新生儿奶粉",
    );
    const verifiedTopic = merged.verifiedPlatformTopics.find(
      (item) => item.displayText === "#新生儿奶粉",
    );
    expect(textCandidate?.evidenceType).toBe("TEXT_HASHTAG_CANDIDATE");
    expect(textCandidate?.isLinkElement).toBe(false);
    expect(verifiedTopic?.evidenceType).toBe("VERIFIED_PLATFORM_TOPIC");
    expect(verifiedTopic?.isClickable).toBe(true);
  });

  it("结构化话题必须精确绑定当前 noteId，推荐笔记话题不能补位", () => {
    const candidates = collectJsonCandidates({
      items: [
        {
          id: "6a5cb375000000000301c541",
          note_card: { topics: [{ name: "当前作品话题" }] },
        },
        {
          id: "6a5cb375000000000301c542",
          note_card: { topics: [{ name: "推荐作品话题" }] },
        },
      ],
    });
    expect(
      verifiedTopicsForCurrentNote(
        candidates,
        "6a5cb375000000000301c541",
      ).map((topic) => topic.displayText),
    ).toEqual(["#当前作品话题"]);
  });

  it("评论结构中的话题对象不能算当前作品话题", () => {
    const candidates = collectJsonCandidates({
      note_id: "6a5cb375000000000301c541",
      topics: [{ name: "当前作品话题" }],
      comments: [
        { topics: [{ name: "评论话题" }] },
      ],
    });
    expect(
      verifiedTopicsForCurrentNote(
        candidates,
        "6a5cb375000000000301c541",
      ).map((topic) => topic.displayText),
    ).toEqual(["#当前作品话题"]);
  });

  it("页面证据 URL 会遮蔽查询令牌", () => {
    const value = safeEvidenceUrl(
      "https://www.xiaohongshu.com/explore/abc?xsec_token=secret&source=share",
    );
    expect(value).not.toContain("secret");
    expect(value).toContain("source=share");
  });
});
