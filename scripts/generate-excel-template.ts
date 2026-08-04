import ExcelJS from "exceljs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { productStageTopicLabel } from "../lib/product-stage";
import { MIN_BODY_LENGTH } from "../lib/audit-constants";

const prisma = new PrismaClient();

function styleSheet(
  sheet: ExcelJS.Worksheet,
  options: { fill?: string; font?: string } = {},
) {
  const header = sheet.getRow(1);
  header.font = {
    bold: true,
    color: { argb: options.font || "FFFFFFFF" },
  };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: options.fill || "FFB4232A" },
  };
  header.alignment = { vertical: "middle", wrapText: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(sheet.columnCount, 1) },
  };
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "小红书笔记合规审核系统";
  const sheet = workbook.addWorksheet("笔记导入模板");
  sheet.columns = [
    { header: "平台（必填）", key: "platform", width: 16 },
    { header: "店铺名称（必填）", key: "shopName", width: 24 },
    { header: "客户名（必填）", key: "customerName", width: 20 },
    { header: "产品系列（必填）", key: "productName", width: 26 },
    { header: "阶段（IFFO/GUM）", key: "productStage", width: 18 },
    { header: "订单编号", key: "orderNumber", width: 22 },
    { header: "内容渠道（必填）", key: "contentChannel", width: 18 },
    { header: "链接（必填）", key: "url", width: 52 },
    { header: "发帖时间（必填）", key: "publishTime", width: 22 },
  ];
  sheet.addRow({
    platform: "小红书",
    shopName: "示例店铺",
    customerName: "示例客户",
    productName: "爱他美奇迹绿罐",
    productStage: "IFFO",
    orderNumber: "JD202608030001",
    contentChannel: "小红书",
    url: "https://xhslink.com/示例短链",
    publishTime: new Date(Date.UTC(2026, 7, 3, 12, 0, 0)),
  });
  for (let row = 2; row <= 5001; row += 1) {
    sheet.getCell(row, 5).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"IFFO,GUM"'],
      showErrorMessage: true,
      errorTitle: "产品阶段话题无效",
      error: "产品阶段话题请填写 IFFO 或 GUM。",
    };
  }
  sheet.getColumn(8).alignment = { vertical: "top", wrapText: true };
  sheet.getColumn(9).numFmt = "yyyy-mm-dd hh:mm:ss";
  styleSheet(sheet, { fill: "FFFFFF00", font: "FF000000" });

  const outputDir = path.join(process.cwd(), "templates");
  await mkdir(outputDir, { recursive: true });
  await workbook.xlsx.writeFile(path.join(outputDir, "笔记导入模板.xlsx"));

  const campaign = await prisma.campaign.findFirst({
    where: { status: "ACTIVE", deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      products: {
        orderBy: { sortOrder: "asc" },
        include: { product: { include: { aliases: true } } },
      },
      topicRules: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: { product: true },
      },
    },
  });
  if (!campaign) throw new Error("没有可用于生成规则模板的活动");

  const ruleWorkbook = new ExcelJS.Workbook();
  ruleWorkbook.creator = "小红书笔记合规审核系统";
  const campaignSheet = ruleWorkbook.addWorksheet("活动基础规则");
  campaignSheet.columns = [
    { header: "活动名称", key: "name", width: 36 },
    { header: "活动年份", key: "year", width: 12 },
    { header: "活动月份", key: "month", width: 12 },
    { header: "开始日期", key: "startDate", width: 14 },
    { header: "结束日期", key: "endDate", width: 14 },
    { header: "最低图片数量", key: "minImageCount", width: 16 },
    { header: "正文最低有效字数", key: "minBodyLength", width: 20 },
    { header: "要求公开", key: "publicRequired", width: 12 },
    { header: "最低保留天数", key: "retentionDays", width: 16 },
    { header: "奖励说明", key: "rewardDescription", width: 42 },
    { header: "来源说明", key: "sourceDescription", width: 42 },
    { header: "客服登记备注", key: "customerRegistrationNotes", width: 70 },
  ];
  campaignSheet.addRow({
    name: campaign.name,
    year: campaign.year || Number(campaign.month.slice(0, 4)),
    month: campaign.month,
    startDate: campaign.startDate.toISOString().slice(0, 10),
    endDate: campaign.endDate.toISOString().slice(0, 10),
    minImageCount: campaign.minImageCount,
    minBodyLength: MIN_BODY_LENGTH,
    publicRequired: campaign.publicRequired ? "是" : "否",
    retentionDays: campaign.retentionDays,
    rewardDescription: campaign.rewardDescription || "",
    sourceDescription: "由系统当前标准化活动规则生成",
    customerRegistrationNotes:
      campaign.customerRegistrationNotes ||
      "图片数量由系统自动审核；图片内容要求由客服登记时人工检查",
  });
  campaignSheet.getRow(2).alignment = {
    vertical: "top",
    wrapText: true,
  };
  campaignSheet.getRow(2).height = 100;
  styleSheet(campaignSheet);

  const productSheet = ruleWorkbook.addWorksheet("产品资料");
  productSheet.columns = [
    { header: "产品编码", key: "code", width: 18 },
    { header: "产品系列", key: "seriesName", width: 26 },
    { header: "产品名称", key: "name", width: 28 },
    { header: "产品别名", key: "aliases", width: 38 },
    { header: "奶粉类型", key: "milkType", width: 16 },
    { header: "产品阶段话题", key: "productStage", width: 30 },
  ];
  for (const { product } of campaign.products) {
    productSheet.addRow({
      code: product.code || null,
      seriesName: product.seriesName || product.name,
      name: product.name,
      aliases: product.aliases.map((alias) => alias.alias).join("、"),
      milkType: null,
      productStage: null,
    });
  }
  styleSheet(productSheet);

  const topicSheet = ruleWorkbook.addWorksheet("话题规则");
  topicSheet.columns = [
    { header: "所属产品", key: "productName", width: 28 },
    { header: "所属活动", key: "campaignName", width: 36 },
    { header: "产品阶段话题", key: "applicableStage", width: 30 },
    { header: "奶粉类型", key: "milkType", width: 14 },
    { header: "标准话题词", key: "topic", width: 30 },
    { header: "匹配策略", key: "policy", width: 16 },
    { header: "话题类别", key: "category", width: 18 },
    { header: "精确匹配", key: "exactMatch", width: 12 },
    { header: "要求可点击", key: "clickableRequired", width: 14 },
    { header: "最少满足数量", key: "minCount", width: 16 },
    { header: "排序", key: "sortOrder", width: 10 },
    { header: "状态", key: "status", width: 10 },
  ];
  const policyLabels: Record<string, string> = {
    REQUIRED: "必须全部包含",
    MUST_ALL: "必须全部包含",
    BRAND_COMMON: "必须全部包含",
    ANY: "任意包含",
    FORBIDDEN: "禁止出现",
  };
  const categoryLabels: Record<string, string> = {
    BRAND_COMMON: "品牌通用",
    PRODUCT_COMMON: "产品通用",
    PRODUCT_STAGE: "产品阶段话题",
  };
  const exportedTopicRuleKeys = new Set<string>();
  for (const rule of campaign.topicRules) {
    const applicableStage = rule.applicableStage
      ? productStageTopicLabel(rule.applicableStage)
      : null;
    const exportKey = [
      rule.productId || "*",
      rule.topicCategory || "*",
      applicableStage,
      rule.topic,
    ].join("|");
    if (exportedTopicRuleKeys.has(exportKey)) continue;
    exportedTopicRuleKeys.add(exportKey);
    topicSheet.addRow({
      productName: rule.product?.name || null,
      campaignName: campaign.name,
      applicableStage,
      milkType: rule.milkType || null,
      topic: rule.topic,
      policy: policyLabels[rule.ruleType] || "必须全部包含",
      category: categoryLabels[rule.topicCategory || ""] || "产品通用",
      exactMatch: rule.exactMatch ? "是" : "否",
      clickableRequired: rule.clickableRequired ? "是" : "否",
      minCount: rule.minCount,
      sortOrder: rule.sortOrder,
      status: rule.status === "ACTIVE" ? "启用" : "停用",
    });
  }
  styleSheet(topicSheet);

  const directionSheet = ruleWorkbook.addWorksheet("内容参考方向");
  directionSheet.columns = [
    { header: "产品名称", key: "name", width: 28 },
    { header: "内容参考方向", key: "contentDirection", width: 90 },
    { header: "用途说明", key: "usage", width: 42 },
  ];
  for (const { product } of campaign.products) {
    directionSheet.addRow({
      name: product.name,
      contentDirection: product.contentDirection || null,
      usage: "仅作创作提示和客服参考，不要求正文逐字出现",
    });
  }
  directionSheet.getColumn(2).alignment = {
    vertical: "top",
    wrapText: true,
  };
  styleSheet(directionSheet);
  await ruleWorkbook.xlsx.writeFile(
    path.join(outputDir, "活动规则标准导入模板.xlsx"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "模板生成失败");
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
