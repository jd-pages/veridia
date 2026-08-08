import type { ExtractedNote } from "@/lib/types";

export type MockCase =
  | "passed"
  | "failed"
  | "few-images"
  | "empty-body"
  | "inaccurate-topic"
  | "unclickable-topic"
  | "read-failed"
  | "not-found"
  | "deleted"
  | "no-permission"
  | "login-expired"
  | "security-verification"
  | "no-images"
  | "live-photo"
  | "video-note"
  | "no-topics"
  | "structure-mismatch"
  | "aptamil-passed"
  | "aptamil-stage2-passed"
  | "aptamil-stage2-store-passed"
  | "aptamil-stage2-folo-store-passed"
  | "aptamil-stage2-rockcheck-store-passed"
  | "aptamil-wrong-stage"
  | "aptamil-plain-topic";

const clickableTopic = (displayText: string) => ({
  displayText,
  isLinkElement: true,
  hasHref: true,
  href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(
    displayText.replace(/^#/, ""),
  )}`,
  textColor: "rgb(19, 119, 255)",
  styleFeature: true,
  domPath: `a.topic[data-topic="${displayText.replace(/^#/, "")}"]`,
});

export function createMockNote(
  caseName: MockCase,
  baseUrl = "http://localhost:3100/mock/xhs",
): ExtractedNote {
  const base: ExtractedNote = {
    url: `${baseUrl}?case=${caseName}`,
    noteId: `mock-${caseName}`,
    title: "孩子最近胃口好多了，我的营养搭配记录",
    body:
      "这段时间更重视日常营养搭配，除了正常吃饭，也会关注锌等营养元素。记录一下我们的真实体验，饮食还是第一位。",
    noteType: "IMAGE_TEXT",
    imageExtractionStatus: "SUCCESS",
    imageCount: 3,
    topics: [clickableTopic("#inne多维锌"), clickableTopic("#宝宝营养")],
    pageStatus: "NORMAL",
    authorName: "营养记录员小安",
    publishedAt: "2026-07-08T08:30:00.000Z",
    publishedAtRaw: "2026-07-08 16:30:00",
    publishedAtSource: "MOCK_PLATFORM",
    isPublic: true,
    extractedAt: new Date().toISOString(),
    adapterName: "mock-xhs",
    adapterVersion: "1.0.0",
  };

  switch (caseName) {
    case "few-images":
      return {
        ...base,
        imageCount: 1,
      };
    case "empty-body":
      return { ...base, body: "   " };
    case "inaccurate-topic":
      return {
        ...base,
        topics: [clickableTopic("#inne多维辛"), clickableTopic("#宝宝营养")],
      };
    case "unclickable-topic":
      return {
        ...base,
        topics: [
          {
            displayText: "#inne多维锌",
            isLinkElement: false,
            hasHref: false,
            href: null,
            textColor: "rgb(19, 119, 255)",
            styleFeature: false,
            domPath: "span.fake-topic",
            source: "DOM_TEXT",
          },
          clickableTopic("#宝宝营养"),
        ],
      };
    case "failed":
      return {
        ...base,
        topics: [
          clickableTopic("#inne多维锌"),
          clickableTopic("#治疗挑食"),
        ],
      };
    case "read-failed":
      return {
        ...base,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "READ_FAILED",
      };
    case "not-found":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "NOTE_NOT_FOUND",
      };
    case "deleted":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "NOTE_NOT_FOUND",
      };
    case "no-permission":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "NO_PERMISSION",
      };
    case "login-expired":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "LOGIN_EXPIRED",
      };
    case "security-verification":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "NOT_CHECKED",
        imageCount: undefined,
        topics: [],
        pageStatus: "SECURITY_VERIFICATION",
      };
    case "no-images":
      return {
        ...base,
        noteType: "UNKNOWN",
        imageExtractionStatus: "IMAGES_READ_FAILED",
        imageCount: undefined,
      };
    case "live-photo":
      return {
        ...base,
        noteType: "IMAGE_TEXT",
        imageExtractionStatus: "SUCCESS",
        imageCount: 3,
        pageEvidence: {
          mediaEvidence: {
            livePhotoMarker: true,
            carouselPageIndicator: "1/3",
            carouselCurrent: 1,
            carouselTotal: 3,
            carouselStructure: true,
            domImageCandidateCount: 1,
            domHasVideo: true,
            videoCandidateCount: 1,
            videoEvidence: ["VIDEO_ELEMENT", "VIDEO_ATTRIBUTES"],
            noteTypeDecision: "IMAGE_TEXT",
            noteTypeReason: "IMAGE_CAROUSEL",
            resolvedImageCount: 3,
          },
        },
      };
    case "video-note":
      return {
        ...base,
        noteType: "VIDEO_NOTE",
        imageExtractionStatus: "VIDEO_NOTE",
        imageCount: undefined,
      };
    case "no-topics":
      return { ...base, topics: [] };
    case "structure-mismatch":
      return {
        ...base,
        title: null,
        body: null,
        noteType: "UNKNOWN",
        imageExtractionStatus: "IMAGES_READ_FAILED",
        imageCount: undefined,
        topics: [],
      };
    case "aptamil-passed":
      return {
        ...base,
        title: "我们的爱他美澳洲白金版真实体验",
        body:
          "这段时间给宝宝选择爱他美澳洲白金版PRE段，冲调方便，宝宝适应得也不错。这里记录真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#新生儿奶粉"),
        ],
      };
    case "aptamil-stage2-passed":
      return {
        ...base,
        title: "我们的爱他美澳洲白金版2段真实体验",
        body:
          "宝宝目前正在喝爱他美澳洲白金版2段奶粉，冲调方便，适应得也不错。这里记录我们的真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#新生儿奶粉"),
          clickableTopic("#二段奶粉推荐"),
        ],
      };
    case "aptamil-stage2-store-passed":
      return {
        ...base,
        title: "京东健康官方进口超市爱他美2段真实体验",
        body:
          "宝宝目前正在喝爱他美澳洲白金版2段奶粉，冲调方便，适应得也不错。这里记录我们的真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#新生儿奶粉"),
          clickableTopic("#二段奶粉推荐"),
          clickableTopic("#京东健康官方进口超市"),
        ],
      };
    case "aptamil-stage2-folo-store-passed":
      return {
        ...base,
        title: "FOLO 海外专营店爱他美2段真实体验",
        body:
          "宝宝目前正在喝爱他美澳洲白金版2段奶粉，冲调方便，适应得也不错。这里记录我们的真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#二段奶粉推荐"),
          clickableTopic("#FOLO海外专营店"),
        ],
      };
    case "aptamil-stage2-rockcheck-store-passed":
      return {
        ...base,
        title: "ROCKCHECK 海外旗舰店爱他美2段真实体验",
        body:
          "宝宝目前正在喝爱他美澳洲白金版2段奶粉，冲调方便，适应得也不错。这里记录我们的真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#二段奶粉推荐"),
          clickableTopic("#ROCKCHECK海外旗舰店"),
          clickableTopic("#天猫"),
        ],
      };
    case "aptamil-wrong-stage":
      return {
        ...base,
        title: "段位话题错误案例",
        body:
          "这段时间给宝宝选择爱他美澳洲白金版2段，冲调方便，宝宝适应得也不错。这里记录真实喂养体验，日常状态稳定，家里人也更放心。",
        imageCount: 2,
        topics: [
          clickableTopic("#爱他美新手爸妈日记"),
          clickableTopic("#爱他美澳洲白金版"),
          clickableTopic("#二段奶粉推荐"),
        ],
      };
    case "aptamil-plain-topic":
      return {
        ...base,
        title: "正文里写了话题但没有可点击链接",
        body:
          "这段时间给宝宝选择爱他美澳洲白金版P段，正文写着爱他美新手爸妈日记、新生儿奶粉，但这些文字没有形成可点击话题链接。",
        imageCount: 2,
        topics: [],
      };
    default:
      return base;
  }
}

export const mockCaseLabels: Record<MockCase, string> = {
  passed: "完整通过",
  failed: "命中禁止话题",
  "few-images": "图片数量不足",
  "empty-body": "缺少正文",
  "inaccurate-topic": "话题不准确",
  "unclickable-topic": "话题不可点击",
  "read-failed": "页面读取失败",
  "not-found": "页面不存在",
  deleted: "笔记已删除",
  "no-permission": "无权限访问",
  "login-expired": "登录失效",
  "security-verification": "安全验证",
  "no-images": "图片数量读取失败",
  "live-photo": "LIVE 实况图轮播",
  "video-note": "视频笔记",
  "no-topics": "未识别到话题",
  "structure-mismatch": "页面结构不匹配",
  "aptamil-passed": "爱他美规则通过",
  "aptamil-stage2-passed": "爱他美IFFO 2段规则通过",
  "aptamil-stage2-store-passed": "爱他美IFFO 2段与店铺话题规则通过",
  "aptamil-stage2-folo-store-passed": "爱他美IFFO 2段与 FOLO 店铺话题规则通过",
  "aptamil-stage2-rockcheck-store-passed": "爱他美IFFO 2段与 ROCKCHECK 店铺备选话题通过",
  "aptamil-wrong-stage": "爱他美段位话题错误",
  "aptamil-plain-topic": "正文同文但话题不可点击",
};
