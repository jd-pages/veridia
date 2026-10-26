import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { writeFile } from "node:fs/promises";
import { PlaywrightXiaohongshuAdapter } from "../../lib/automation/adapters";
import { collectJsonCandidates, createEmptyCandidates } from "../../lib/automation/xhs-page-evidence";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMockNote } from "../../lib/mock-data";

// Isolated transport fixtures test the actual extractor/API/download chain.
// They are explicitly not counted as live-platform acceptance.
test("1.1.43 预计人工复查日期：真实隔离API、页面及17列下载，不改快照或创建自动任务", async ({ page }, info) => {
  test.setTimeout(90000);
  if (!process.env.E2E_DATABASE_URL) throw Error("Isolated DB required");
  const db = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL });
  const suffix = randomUUID();
  const product = await db.product.create({ data: { name: `人工预计日期-${suffix}`, brandName: "佳贝艾特" } });
  const campaign = await db.campaign.create({ data: { name: `预计日期隔离-${suffix}`, productId: product.id,
    month: "2026-10", startDate: new Date("2026-10-01"), endDate: new Date("2026-10-31"),
    contentChannel: "XIAOHONGSHU", minBodyLength: 1, minImageCount: 0, retentionDays: 30,
    rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50,
    interactionRewardTiers: { create: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] },
    products: { create: { productId: product.id } } } });
  const resultIds: string[] = [];
  try {
    expect((await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).ok()).toBeTruthy();
    await db.automationSession.updateMany({ where: { platform: "XIAOHONGSHU" }, data: { status: "UNKNOWN" } });
    const rules = await db.topicRule.findMany({ where: { brandName: "佳贝艾特", scope: "GLOBAL", status: "ACTIVE", ruleType: { not: "FORBIDDEN" } } });
    const expected = [
      { key: "estimated", date: "2026-10-31", estimated: true },
      { key: "confirmed", date: "2026-11-04", estimated: false },
      { key: "urlOnly", date: "2026-10-31", estimated: true },
      { key: "mismatch", date: "发布时间待确认", estimated: false },
      { key: "future", date: "发布时间待确认", estimated: false },
    ];
    for (const sample of expected) {
      const id = (sample.key === "future" ? "ffffffff" : Math.floor(Date.parse("2026-10-01T15:30:00Z") / 1000).toString(16)) + randomUUID().replaceAll("-", "").slice(0, 16);
      const url = `https://www.xiaohongshu.com/explore/${id}`;
      const task = await db.auditTask.create({ data: { productId: product.id, campaignId: campaign.id, url, normalizedUrl: url, channel: "XIAOHONGSHU" } });
      const mock = createMockNote("passed");
      const extraction = { ...mock, noteId: id, url, finalUrl: url, title: product.name, body: "仅用于隔离验收的完整审核正文。".repeat(10),
        topics: rules.map(rule => ({ ...mock.topics[0], displayText: rule.topic, isClickable: true,
          href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(rule.topic)}` })),
        likeCount: 13, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS",
        publishedAt: sample.key === "confirmed" ? "2026-10-05T02:00:00Z" : null,
        publishedAtRaw: sample.key === "confirmed" ? "2026-10-05" : null,
        publishedAtSource: sample.key === "confirmed" ? "NETWORK_JSON:note.publish_time" : null };
      const response = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { extraction } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const result = (await response.json()).data;
      resultIds.push(result.id);
      if (["mismatch", "urlOnly"].includes(sample.key)) {
        const record = await db.extractionRecord.findUniqueOrThrow({ where: { id: result.extractionRecordId } });
        const raw = JSON.parse(record.rawData);
        raw.noteId = sample.key === "urlOnly" ? null : "6a0000000000000000000000";
        await db.extractionRecord.update({ where: { id: record.id }, data: { rawData: JSON.stringify(raw) } });
      }
      const detail = (await (await page.request.get(`/api/results/${result.id}`)).json()).data;
      expect(detail.presentation.kabrita).toMatchObject({ nextReviewAt: sample.date, nextReviewEstimated: sample.estimated,
        payoutAmount: 70, payoutState: expect.stringContaining("待复核") });
    }
    const before = await db.auditResult.findMany({ where: { id: { in: resultIds } }, select: { id: true, ruleSnapshot: true, retentionStatus: true, retentionDueAt: true, extractionRecord: { select: { rawData: true } } }, orderBy: { id: "asc" } });
    // A mutable latest Note must not change a result's historical manual date.
    await db.noteRecord.updateMany({ where: { auditResults: { some: { id: { in: resultIds } } } }, data: { publishedAt: new Date("2035-01-01"), platformNoteId: null } });
    await page.goto("/results?startDate=2020-01-01&endDate=2099-12-31");
    await page.getByLabel("关键词搜索").fill(product.name);
    await page.getByRole("button", { name: "查询" }).click();
    const ui = page.locator(`.ant-table-row[data-row-key="${resultIds[0]}"]`);
    await expect(ui.getByLabel("佳贝艾特审核与打款")).toContainText("预计日期（笔记ID推算）");
    await expect(ui).toContainText("2026-10-31");
    await ui.getByRole("button", { name: /查看详情/u }).click();
    await expect(page.locator(".ant-drawer-content")).toContainText("仅供人工安排复查");
    await page.locator(".ant-drawer-content").screenshot({ path: info.outputPath("estimated-manual-review-ui.png"), animations: "disabled" });
    const downloaded = await page.request.get(`/api/results/export?format=xlsx&ids=${resultIds.join(",")}`);
    expect(downloaded.ok(), await downloaded.text()).toBeTruthy();
    const bytes = await downloaded.body(), file = info.outputPath("1.1.43-预计人工复查-实际17列下载.xlsx");
    await writeFile(file, bytes); await info.attach("actual estimated-date workbook", { path: file, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = book.getWorksheet("佳贝艾特审核结果")!;
    expect(sheet.columnCount).toBe(17);expect(sheet.rowCount).toBe(6);
    for (const [index, sample] of expected.entries()) {
      const original = await db.auditTask.findUniqueOrThrow({ where: { id: (await db.auditResult.findUniqueOrThrow({ where: { id: resultIds[index] } })).auditTaskId } });
      const row = Array.from({ length: 5 }, (_, offset) => sheet.getRow(offset + 2)).find(row => String(row.getCell(11).value).includes(original.url))!;
      const q = row.getCell(17);
      expect(row.getCell(16).value).toBe(70);
      expect(q.value).toEqual(/^\d{4}/u.test(sample.date) ? new Date(`${sample.date}T00:00:00Z`) : sample.date);
      if (sample.estimated) {expect(q.numFmt).toBe('yyyy-mm-dd"（预计）"');expect(q.note).toContain("笔记ID推算");}
      else if (sample.key === "confirmed") expect(q.numFmt).toBe("yyyy-mm-dd");
    }
    const csv = await page.request.get(`/api/results/export?format=csv&ids=${resultIds.join(",")}`);
    expect(csv.ok()).toBeTruthy();expect(await csv.text()).toContain("2026-10-31（预计：笔记ID推算，仅供人工复查）");
    expect(await db.auditResult.findMany({ where: { id: { in: resultIds } }, select: { id: true, ruleSnapshot: true, retentionStatus: true, retentionDueAt: true, extractionRecord: { select: { rawData: true } } }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.auditTask.count({ where: { productId: product.id } })).toBe(5);
    expect(await db.auditBatch.count({ where: { productId: product.id } })).toBe(0);
    await info.attach("manual-only-date-isolation-receipt", { body: Buffer.from(JSON.stringify({ rows: expected, historicalSnapshotUnchanged: true, retentionUnchanged: true, newAutomaticTasks: 0, newBatches: 0, sampleKind: "ISOLATED_DB_REAL_API_UI_XLSX_DOWNLOAD" }, null, 2)), contentType: "application/json" });
  } finally {
    const notes = await db.auditResult.findMany({ where: { task: { productId: product.id } }, select: { noteId: true } });
    await db.$transaction(async tx => {
      await tx.auditResult.deleteMany({ where: { task: { productId: product.id } } });
      await tx.extractionRecord.deleteMany({ where: { task: { productId: product.id } } });
      await tx.noteProduct.deleteMany({ where: { productId: product.id } });
      await tx.auditTask.deleteMany({ where: { productId: product.id } });
      await tx.noteRecord.deleteMany({ where: { id: { in: notes.map(n => n.noteId) }, auditResults: { none: {} }, extractions: { none: {} }, noteProducts: { none: {} } } });
      await tx.campaignProduct.deleteMany({ where: { campaignId: campaign.id } });
      await tx.campaign.delete({ where: { id: campaign.id } });await tx.product.delete({ where: { id: product.id } });
    });
    await db.$disconnect();
  }
});

test("Protected XHS_BUSINESS_DATA_IDENTITY：结构化/内嵌/DOM采集与17列真实下载保持一致", async ({ page, context }, info) => {
  const datasourceUrl = process.env.E2E_DATABASE_URL;
  if (!datasourceUrl) throw new Error("isolated E2E database required");
  const db = new PrismaClient({ datasourceUrl });
  const suffix = randomUUID();
  expect((await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).ok()).toBeTruthy();
  const product = await db.product.create({ data: { name: `XHS业务闭环-${suffix}`, brandName: "佳贝艾特" } });
  const campaign = await db.campaign.create({ data: { name: `十月隔离合同-${suffix}`, productId: product.id, month: "2026-10",
    startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T23:59:59Z"),
    contentChannel: "XIAOHONGSHU", rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50,
    retentionDays: 30, minBodyLength: 1, minImageCount: 0, clickableTopicRequired: true,
    products: { create: { productId: product.id } },
    interactionRewardTiers: { create: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] },
  } });
  const topic = `#自动采集${suffix.replaceAll("-", "")}`;
  await db.topicRule.create({ data: { brandName: "佳贝艾特", scope: "CAMPAIGN", campaignId: campaign.id,
    topic, ruleType: "MUST_ALL", clickableRequired: true, contentChannel: "XIAOHONGSHU" } });
  const defaults = await db.topicRule.findMany({ where: { brandName: "佳贝艾特", scope: "GLOBAL", status: "ACTIVE", ruleType: { not: "FORBIDDEN" } } });
  const topics = [...defaults.map((rule) => rule.topic), topic];
  const extractionPage = await context.newPage();
  const rows: Array<{ id: string; total: number; payout: number }> = [];
  try {
    for (const [index, total] of [0,9,10,13,39,40,52].entries()) {
      const id = randomUUID().replaceAll("-", "").slice(0,24);
      const canonical = index === 3;
      const url = `https://www.xiaohongshu.com/${canonical ? "discovery/item" : "explore"}/${id}`;
      const task = await db.auditTask.create({ data: { productId: product.id, campaignId: campaign.id, url, normalizedUrl: url, channel: "XIAOHONGSHU" } });
      const state = { note: { noteDetailMap: { [id]: { note: { noteId: id, time: 1_790_856_000_000,
        interactInfo: { likedCount: String(total), commentCount: "0", collectedCount: "0" } } } } } };
      const embedded = index % 3 === 1 ? `<script>window.__INITIAL_STATE__=${JSON.stringify(state).slice(0,-1)},"cache":new Map([])};</script>` : "";
      const html = `<meta charset="utf-8"><main id="noteContainer" data-xhs-note-id="${id}"><h1 id="detail-title">隔离采集</h1><div id="detail-desc">真实DOM采集链路验证正文${topics.map((value)=>`<a href="https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(value)}">${value}</a>`).join(" ")}</div><time data-testid="note-publish-time">发布于 2026-10-01</time><video></video><div data-testid="note-action-bar" class="interactions engage-bar"><span class="like-wrapper"><span class="count">${total}</span></span><span class="collect-wrapper"><span class="count">0</span></span><span class="chat-wrapper"><span class="count">0</span></span></div></main>${embedded}`;
      await extractionPage.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
      await extractionPage.goto(url);
      if (canonical) await extractionPage.locator('[data-testid="note-action-bar"]').evaluate(element => element.remove());
      const extracted = await new PlaywrightXiaohongshuAdapter().extract(extractionPage, url, {
        responseCandidates: index % 3 === 0 && !canonical ? collectJsonCandidates(state, "NETWORK_JSON") : undefined,
        readResponseCandidates: canonical ? async () => {
          await extractionPage.evaluate(next => history.replaceState({}, "", next), `/explore/${id}?source=share`);
          return collectJsonCandidates(state, "NETWORK_JSON");
        } : undefined,
      });
      expect(extracted.interactionExtractionStatus).toBe("SUCCESS");
      expect(extracted.likeCount! + extracted.commentCount! + extracted.favoriteCount!).toBe(total);
      expect(extracted.publishedAt).toBeTruthy();
      expect(extracted.pageEvidence?.businessDataReceipt).toMatchObject({ noteId: id, blockers: [] });
      if (canonical) expect(extracted.pageEvidence?.businessDataReceipt).toMatchObject({
        sameNoteNavigation: { status: "IDENTITY_VERIFIED", noteId: id },
      });
      await info.attach(`extractor-${index}`, { body: Buffer.from(JSON.stringify(extracted,null,2)), contentType:"application/json" });
      expect(extracted.topics.map((value)=>value.displayText)).toEqual(expect.arrayContaining(topics));
      const audited = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { extraction: extracted } });
      expect(audited.ok(), await audited.text()).toBeTruthy();
      const result = (await audited.json()).data;
      expect(result.autoStatus, result.failureReasons).toBe("PASSED");
      const detail = (await (await page.request.get(`/api/results/${result.id}`)).json()).data;
      const payout = total < 10 ? 50 : total < 40 ? 70 : 100;
      expect(detail.presentation.kabrita).toMatchObject({ complianceResult: "Y", interactionTotal: total, payoutAmount: payout, nextReviewAt: "2026-10-31" });
      rows.push({ id: result.id, total, payout });
    }
    // Negative boundary: a hydration update cannot substitute another note's
    // counters between the first identity check and the bounded supplement.
    await extractionPage.evaluate(() => {
      document.querySelector('[data-testid="note-action-bar"]')?.remove();
      document.querySelectorAll("script").forEach(element => element.remove());
    });
    await expect(new PlaywrightXiaohongshuAdapter().extract(extractionPage, extractionPage.url(), {
      readResponseCandidates: async () => {
        await extractionPage.locator("#noteContainer").evaluate(element => element.setAttribute("data-xhs-note-id", "ffffffffffffffffffffffff"));
        return createEmptyCandidates();
      },
    })).rejects.toThrow("CURRENT_NOTE_ID_MISMATCH");
    const sameNoteUrl = extractionPage.url();
    await extractionPage.locator("#noteContainer").evaluate((element, id) => element.setAttribute("data-xhs-note-id", id), new URL(sameNoteUrl).pathname.split("/").at(-1)!);
    await expect(new PlaywrightXiaohongshuAdapter().extract(extractionPage, sameNoteUrl, {
      readResponseCandidates: async () => {
        await extractionPage.evaluate(() => history.replaceState({}, "", "/explore/ffffffffffffffffffffffff"));
        return createEmptyCandidates();
      },
    })).rejects.toThrow("CURRENT_NOTE_ID_MISMATCH");
    const response = await page.request.get(`/api/results/export?format=xlsx&ids=${rows.map((row)=>row.id).join(",")}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const bytes = await response.body(), file = info.outputPath("XHS业务数据-实际17列下载.xlsx");
    await writeFile(file, bytes); await info.attach("actual isolated API XLSX", { path: file, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("佳贝艾特审核结果")!;
    expect(sheet.columnCount).toBe(17); expect(sheet.rowCount).toBe(rows.length+1);
    for (const row of rows) {
      const exported = Array.from({length:rows.length},(_,index)=>sheet.getRow(index+2)).find((value)=>value.getCell(15).value===row.total)!;
      expect(exported.getCell(13).value).toBe("Y"); expect(exported.getCell(16).value).toBe(row.payout);
      expect(exported.getCell(17)).toMatchObject({ value: new Date("2026-10-31T00:00:00Z"), numFmt: "yyyy-mm-dd" });
    }
    await info.attach("acquisition-row-reconciliation", { body: Buffer.from(JSON.stringify({sampleKind:"ISOLATED_TRANSPORT_FIXTURE_NOT_LIVE_PLATFORM",rows},null,2)), contentType:"application/json" });
  } finally {
    await extractionPage.close();
    const results = await db.auditResult.findMany({where:{task:{productId:product.id}},select:{noteId:true}});
    await db.$transaction(async(tx)=>{
      await tx.auditResult.deleteMany({where:{task:{productId:product.id}}});
      await tx.extractionRecord.deleteMany({where:{task:{productId:product.id}}});
      await tx.noteProduct.deleteMany({where:{productId:product.id}});
      await tx.auditTask.deleteMany({where:{productId:product.id}});
      await tx.noteRecord.deleteMany({where:{id:{in:results.map(r=>r.noteId)},auditResults:{none:{}},extractions:{none:{}},noteProducts:{none:{}}}});
      await tx.topicRule.deleteMany({where:{campaignId:campaign.id}});
      await tx.campaignProduct.deleteMany({where:{campaignId:campaign.id}});
      await tx.campaign.delete({where:{id:campaign.id}});
      await tx.product.delete({where:{id:product.id}});
    });
    await db.$disconnect();
  }
});

test("Protected XHS_RESULT_AUTOMATIC_FOLLOW_UP：实际补采队列使用原合同并新增快照，不自动重复失败",async({page},info)=>{
  if(!process.env.E2E_DATABASE_URL)throw Error('Isolated DB required');
  const db=new PrismaClient({datasourceUrl:process.env.E2E_DATABASE_URL}),suffix=randomUUID();
  expect((await page.request.post('/api/auth/login',{data:{username:'admin',password:'Admin123!'}})).ok()).toBeTruthy();
  const product=await db.product.create({data:{name:`补采隔离-${suffix}`,brandName:'佳贝艾特'}});
  const campaign=await db.campaign.create({data:{name:`补采合同-${suffix}`,productId:product.id,month:'2026-10',contentChannel:'XIAOHONGSHU',
    startDate:new Date('2026-10-01T00:00:00Z'),endDate:new Date('2026-10-31T00:00:00Z'),minImageCount:2,minBodyLength:21,retentionDays:30,
    rewardMode:'CONTENT_BASE_PLUS_INTERACTION_TIERS',baseRewardAmount:50,
    interactionRewardTiers:{create:[{threshold:10,amount:20},{threshold:40,amount:50}]}}});
  const required=`#补采${suffix.replaceAll('-','')}`;
  await db.topicRule.create({data:{scope:'CAMPAIGN',brandName:'佳贝艾特',campaignId:campaign.id,topic:required,ruleType:'MUST_ALL',contentChannel:'XIAOHONGSHU'}});
  const globals=await db.topicRule.findMany({where:{brandName:'佳贝艾特',scope:'GLOBAL',status:'ACTIVE',ruleType:{not:'FORBIDDEN'}}});
  const topics=[...globals.map(r=>r.topic),required].map(displayText=>({displayText,isClickable:true,isLinkElement:true,hasHref:true,href:'https://www.xiaohongshu.com/search_result?keyword=topic',styleFeature:true,source:'DOM_LINK'}));
  let url='';
  const server=createServer((_request,response)=>{
    const payload={...createMockNote('passed'),url,noteId:`follow-${suffix}`,topics,verifiedPlatformTopics:topics,topicEvidenceCollected:true,
      likeCount:13,commentCount:0,favoriteCount:0,interactionExtractionStatus:'SUCCESS',publishedAt:'2026-10-01T02:00:00Z',publishedAtSource:'NETWORK_JSON:time',extractedAt:new Date().toISOString()};
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(`<main>隔离补采传输</main><script id="mock-extraction-data" type="application/json">${JSON.stringify(payload).replaceAll('<','\\u003c')}</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/mock/xhs?fixture=${suffix}`;
  const oldSession=await db.automationSession.findUnique({where:{platform:'XIAOHONGSHU'}});
  try{
    const task=await db.auditTask.create({data:{url,normalizedUrl:url,productId:product.id,campaignId:campaign.id,channel:'XIAOHONGSHU'}});
    const originalResponse=await page.request.post(`/api/tasks/${task.id}/audit`,{data:{extraction:{...createMockNote('passed'),url,noteId:`follow-${suffix}`,topics,verifiedPlatformTopics:topics,topicEvidenceCollected:true,
      likeCount:null,commentCount:null,favoriteCount:null,interactionExtractionStatus:'UNAVAILABLE',publishedAt:null,publishedAtSource:null,extractedAt:new Date().toISOString()}}});
    expect(originalResponse.ok(),await originalResponse.text()).toBeTruthy();const original=(await originalResponse.json()).data;
    expect(original.autoStatus).toBe('PASSED');
    const oldExtraction=await db.extractionRecord.findUniqueOrThrow({where:{id:original.extractionRecordId}});
    await db.campaign.update({where:{id:campaign.id},data:{baseRewardAmount:999,rewardMode:'LEGACY'}});
    await db.automationSession.upsert({where:{platform:'XIAOHONGSHU'},create:{id:'xiaohongshu',platform:'XIAOHONGSHU',profilePath:process.env.E2E_XHS_PROFILE_PATH!,status:'READY'},update:{status:'READY'}});
    const follow=await page.request.post('/api/results/follow-up');expect(follow.ok(),await follow.text()).toBeTruthy();
    const queued=(await follow.json()).data;expect(queued).toMatchObject({status:'QUEUED',source:'RESULT_DATA_SUPPLEMENT',originalResultId:original.id});
    await expect.poll(()=>db.auditResult.count({where:{task:{batchId:queued.batchId}}})).toBe(1);
    const revised=await db.auditResult.findFirstOrThrow({where:{task:{batchId:queued.batchId}},include:{task:true,extractionRecord:true}});
    const detail=(await(await page.request.get(`/api/results/${revised.id}`)).json()).data;
    expect(detail.presentation.kabrita).toMatchObject({interactionTotal:13,payoutAmount:70,nextReviewAt:'2026-10-31',complianceResult:'Y'});
    expect(JSON.parse(revised.ruleSnapshot)).toMatchObject({baseRewardAmount:50,rewardMode:'CONTENT_BASE_PLUS_INTERACTION_TIERS'});
    expect((await db.extractionRecord.findUniqueOrThrow({where:{id:oldExtraction.id}})).rawData).toBe(oldExtraction.rawData);
    expect((await db.auditResult.findUniqueOrThrow({where:{id:original.id}})).ruleSnapshot).toBe(original.ruleSnapshot);
    expect(revised.extractionRecordId).not.toBe(original.extractionRecordId);
    expect(JSON.parse(revised.extractionRecord!.rawData).pageEvidence.resultFollowUp).toMatchObject({originalResultId:original.id,purpose:'RESULT_DATA_SUPPLEMENT'});
    await expect.poll(async()=> (await db.auditBatch.findUniqueOrThrow({where:{id:queued.batchId}})).status).toBe('COMPLETED');
    expect((await(await page.request.post('/api/results/follow-up')).json()).data.status).toBe('NO_ELIGIBLE_RECORD');
    expect(await db.auditTask.count({where:{replacesResultId:original.id}})).toBe(1);
    await info.attach('actual automatic supplement receipt',{body:Buffer.from(JSON.stringify({originalResultId:original.id,newResultId:revised.id,output:detail.presentation.kabrita,originalContractUnchanged:true,originalExtractionUnchanged:true,sampleKind:'ISOLATED_TRANSPORT_FIXTURE_NOT_LIVE'},null,2)),contentType:'application/json'});
  }finally{
    // The retained audit browser may keep the fixture HTTP connection open.
    // Close only this fixture server's own sockets, not the application/browser.
    await new Promise<void>((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve()); server.closeAllConnections();
    });
    if(oldSession)await db.automationSession.update({where:{id:oldSession.id},data:{status:oldSession.status}});
    await db.$disconnect();
  }
});
