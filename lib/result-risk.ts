import type { Prisma } from "@prisma/client";

export const RESULT_RISK_TYPES = [
  "NOTE_UNAVAILABLE",
  "TOPIC_MISSING",
  "IMAGE_INSUFFICIENT",
] as const;

export type ResultRiskType = (typeof RESULT_RISK_TYPES)[number];

export const resultRiskLabels: Record<ResultRiskType, string> = {
  NOTE_UNAVAILABLE: "笔记不存在",
  TOPIC_MISSING: "话题缺失",
  IMAGE_INSUFFICIENT: "图片不足",
};

const unavailableStates = [
  "NOTE_NOT_FOUND",
  "PAGE_NOT_FOUND",
  "NOTE_DELETED",
  "PAGE_UNAVAILABLE",
  "ERROR_PAGE",
  "NOT_FOUND",
  "NOT_ACCESSIBLE",
  "DELETED",
];

const unavailablePhrases = [
  "你访问的页面不见了",
  "页面不存在",
  "笔记不存在",
  "笔记已删除",
  "当前笔记无法浏览",
  "该内容无法查看",
  "内容已被删除",
  "错误页",
];

const topicMissingCodes = [
  "MISSING_TOPIC",
  "TOPIC_MISSING",
  "TOPICS_NOT_RECOGNIZED",
];

const topicMissingPhrases = [
  "缺少精准话题",
  "缺少精确话题",
  "未识别到话题",
  "阶段话题未命中",
  "产品话题缺失",
  "通用话题缺失",
  "topic missing",
  "MISSING_TOPIC",
  "TOPIC_MISSING",
];

const imageRiskCodes = [
  "IMAGES_READ_FAILED",
  "IMAGE_COUNT_INSUFFICIENT",
  "IMAGE_COUNT_INVALID",
];

const imageRiskPhrases = [
  "图片数量不足",
  "图片不足",
  "图片数量不合规",
  "图片读取失败",
  "图片数量读取失败",
  "IMAGES_READ_FAILED",
  "IMAGE_COUNT_INSUFFICIENT",
  "IMAGE_COUNT_INVALID",
];

export function parseResultRiskType(
  value: string | null | undefined,
): ResultRiskType | undefined {
  return RESULT_RISK_TYPES.find((candidate) => candidate === value);
}

export function noteUnavailableWhere(): Prisma.AuditResultWhereInput {
  return {
    OR: [
      { pageStatus: { in: unavailableStates } },
      { task: { failureCode: { in: unavailableStates } } },
      { task: { status: { in: unavailableStates } } },
      ...unavailablePhrases.flatMap((phrase) => [
        { failureReasons: { contains: phrase } },
        { task: { failureMessage: { contains: phrase } } },
        { task: { failureEvidence: { contains: phrase } } },
        { task: { pageTitle: { contains: phrase } } },
        { note: { title: { contains: phrase } } },
        { note: { body: { contains: phrase } } },
      ]),
    ],
  };
}

function topicMissingWhere(): Prisma.AuditResultWhereInput {
  return {
    AND: [
      { pageStatus: "NORMAL" },
      {
        OR: [
          { missingTopics: { notIn: ["", "[]"] } },
          { task: { failureCode: { in: topicMissingCodes } } },
          ...topicMissingPhrases.map((phrase) => ({
            failureReasons: { contains: phrase },
          })),
        ],
      },
    ],
  };
}

function imageInsufficientWhere(): Prisma.AuditResultWhereInput {
  return {
    AND: [
      { pageStatus: "NORMAL" },
      {
        OR: [
          { imageStatus: { in: ["NON_COMPLIANT", "IMAGES_READ_FAILED"] } },
          { imageExtractionStatus: "IMAGES_READ_FAILED" },
          { imageCompliant: false },
          { task: { failureCode: { in: imageRiskCodes } } },
          ...imageRiskPhrases.map((phrase) => ({
            failureReasons: { contains: phrase },
          })),
        ],
      },
    ],
  };
}

export function buildResultRiskWhere(
  riskType: ResultRiskType,
): Prisma.AuditResultWhereInput {
  if (riskType === "NOTE_UNAVAILABLE") return noteUnavailableWhere();
  if (riskType === "TOPIC_MISSING") return topicMissingWhere();
  return imageInsufficientWhere();
}
