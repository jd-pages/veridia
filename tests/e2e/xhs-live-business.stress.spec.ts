import { test, expect } from "@playwright/test";
import { PrismaClient, type AuditResult } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { PlaywrightXiaohongshuAdapter } from "../../lib/automation/adapters";
import { createXhsResponseCollector, safeEvidenceUrl } from "../../lib/automation/xhs-page-evidence";

/** Explicit live acceptance, not CI: no routes, mocks, copied cookies or login.
 * Isolated contracts demonstrate calculation, never authorize a real payment. */
test("LIVE XHS → explicit isolated activity contract → UI/API/XLSX/CSV", async ({page,context},info) => {
  const url=process.env.VERIDIA_LIVE_SAMPLE_URL, month=process.env.VERIDIA_LIVE_SAMPLE_MONTH;
  if(!url||!/^2026-(09|10)$/u.test(month||"")||!process.env.E2E_DATABASE_URL)throw Error("Explicit observed live URL/month and isolated DB required");
  const db=new PrismaClient({datasourceUrl:process.env.E2E_DATABASE_URL});
  const suffix=randomUUID(), october=month==='2026-10';
  const expectedStatus = process.env.VERIDIA_LIVE_EXPECTED_CONTENT_STATUS || "PASSED";
  if (!["PASSED", "FAILED"].includes(expectedStatus)) throw Error("EXPLICIT_CONTENT_EXPECTATION_REQUIRED");
  expect((await page.request.post('/api/auth/login',{data:{username:'admin',password:'Admin123!'}})).ok()).toBeTruthy();
  // This dedicated disposable run must not pretend seeded demo-brand rules
  // are the real note's contract. Preserve/restore them and declare the fixture.
  const defaults=await db.topicRule.findMany({where:{brandName:'佳贝艾特',scope:'GLOBAL',status:'ACTIVE'},select:{id:true}});
  await db.topicRule.updateMany({where:{id:{in:defaults.map(r=>r.id)}},data:{status:'INACTIVE'}});
  const product=await db.product.create({data:{name:`LIVE隔离-${suffix}`,brandName:'佳贝艾特'}});
  const campaign=await db.campaign.create({data:{name:`LIVE隔离合同（非正式打款）-${suffix}`,productId:product.id,month:month!,contentChannel:'XIAOHONGSHU',
    startDate:new Date(`${month}-01T00:00:00Z`),endDate:new Date(`${month}-28T00:00:00Z`),
    minImageCount:0,minBodyLength:1,retentionDays:30,rewardMode:october?'CONTENT_BASE_PLUS_INTERACTION_TIERS':'LEGACY',baseRewardAmount:october?50:0,
    products:{create:{productId:product.id}},...(october?{interactionRewardTiers:{create:[{threshold:10,amount:20},{threshold:40,amount:50}]}}:{})}});
  await db.topicRule.create({data:{brandName:'佳贝艾特',scope:'CAMPAIGN',campaignId:campaign.id,topic:'#新生儿奶粉',ruleType:'MUST_ALL',contentChannel:'XIAOHONGSHU',clickableRequired:true}});
  const notePage=await context.newPage(), collector=createXhsResponseCollector(notePage);
  const publicUrl=new URL(url); publicUrl.search='';
  const useRunner=process.env.VERIDIA_LIVE_USE_RUNNER==='true';
  const task=useRunner?null:await db.auditTask.create({data:{productId:product.id,campaignId:campaign.id,url:publicUrl.href,normalizedUrl:publicUrl.href,channel:'XIAOHONGSHU'}});
  const oldSession=await db.automationSession.findUnique({where:{platform:'XIAOHONGSHU'}});
  let liveBatchId:string|null=null;
  try {
    await notePage.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});
    await notePage.locator('#detail-desc').waitFor({state:'visible',timeout:5_000});
    const note=await new PlaywrightXiaohongshuAdapter().extract(notePage,url,{responseCandidates:await collector.snapshot(),readResponseCandidates:collector.snapshot});
    expect(note.pageStatus).toBe('NORMAL');expect(note.interactionExtractionStatus).toBe('SUCCESS');expect(note.publishedAt).toBeTruthy();
    // Strip share tokens from saved records without changing identity/data/time.
    const extraction={...note,url:publicUrl.href,finalUrl:publicUrl.href};
    let result:AuditResult;
    if(useRunner){
      // Public, logged-out detail only. READY is isolated scheduling fixture
      // state, not proof of authentication. Real page/login/security gates stay
      // active; no cookies or credentials are copied to this fresh profile.
      await db.automationSession.upsert({where:{platform:'XIAOHONGSHU'},create:{id:'xiaohongshu',platform:'XIAOHONGSHU',status:'READY',profilePath:process.env.E2E_XHS_PROFILE_PATH!},update:{status:'READY'}});
      const response=await page.request.post('/api/automation/batches',{data:{productId:product.id,campaignId:campaign.id,urls:[url],contentChannel:'XIAOHONGSHU',name:`LIVE公开笔记隔离审核-${suffix}`}});
      expect(response.ok(),await response.text()).toBeTruthy();liveBatchId=(await response.json()).data.batchId;
      await expect.poll(async()=>{
        const batch=await db.auditBatch.findUniqueOrThrow({where:{id:liveBatchId!}});
        if(['PAUSED','LOGIN_EXPIRED','SECURITY_RESTRICTED','COMPLETED_WITH_ERRORS'].includes(batch.status))throw Error(`LIVE_RUNNER_BLOCKED:${batch.status}:${batch.lastErrorCode}`);
        return db.auditResult.count({where:{task:{batchId:liveBatchId}}});
      },{timeout:30_000}).toBe(1);
      result=await db.auditResult.findFirstOrThrow({where:{task:{batchId:liveBatchId}}});
      await expect.poll(async()=>(await db.auditBatch.findUniqueOrThrow({where:{id:liveBatchId!}})).status).toBe('COMPLETED');
    }else{
      const response=await page.request.post(`/api/tasks/${task!.id}/audit`,{data:{extraction}});
      expect(response.ok(),await response.text()).toBeTruthy();result=(await response.json()).data;
    }
    const detail=(await(await page.request.get(`/api/results/${result.id}`)).json()).data;
    expect(result.autoStatus,result.failureReasons).toBe(expectedStatus);
    if (expectedStatus === "FAILED") expect(result.failureReasons).toContain("有效正文字数不足");
    const actual=detail.presentation.kabrita;
    expect(actual.interactionTotal).toBe(result.likeCount!+result.commentCount!+result.favoriteCount!);
    const expectedAmount=october&&expectedStatus==='PASSED'?(actual.interactionTotal<10?50:actual.interactionTotal<40?70:100):null;
    expect(actual.payoutAmount).toBe(expectedAmount);expect(actual.nextReviewAt).toMatch(/^2026-\d{2}-\d{2}$/u);
    const xlsxResponse=await page.request.get(`/api/results/export?format=xlsx&ids=${result.id}`);
    expect(xlsxResponse.ok()).toBeTruthy();const bytes=await xlsxResponse.body();
    const book=new ExcelJS.Workbook();await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet=book.getWorksheet('佳贝艾特审核结果')!;
    expect(sheet.columnCount).toBe(17);expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell('O2').value).toBe(actual.interactionTotal);
    if(expectedStatus==='FAILED') expect(sheet.getCell('P2').text).toContain('内容审核不合格');
    else if(october)expect(sheet.getCell('P2').value).toBe(expectedAmount);
    else expect(sheet.getCell('P2').text).toContain('缺少当次有效奖励规则快照');
    expect(sheet.getCell('Q2').value).toEqual(new Date(`${actual.nextReviewAt}T00:00:00Z`));
    const file=info.outputPath(`LIVE-${month}-17cols.xlsx`);await writeFile(file,bytes);
    await info.attach('LIVE real platform actual API export',{path:file,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const csvResponse=await page.request.get(`/api/results/export?format=csv&ids=${result.id}`);expect(csvResponse.ok()).toBeTruthy();
    const csv=await csvResponse.body(),csvFile=info.outputPath(`LIVE-${month}.csv`);await writeFile(csvFile,csv);
    const csvText=csv.toString('utf8');
    expect(csvText).toContain('打款金额'); expect(csvText).toContain(actual.nextReviewAt);
    expect(csvText).toContain(String(actual.interactionTotal));
    if(expectedAmount!==null) expect(csvText).toContain(String(expectedAmount));
    await info.attach('LIVE actual CSV',{path:csvFile,contentType:'text/csv'});
    await page.setViewportSize({width:1680,height:1080});
    await page.goto(`/results?productId=${encodeURIComponent(product.id)}`);
    const row=page.locator('tr').filter({hasText:product.name}).first();await expect(row).toBeVisible();
    await row.getByRole('button',{name:/查看详情/u}).click();
    const panel=page.locator('[aria-label="佳贝艾特审核与打款"]').last();
    await expect(panel).toContainText(`互动量：${actual.interactionTotal}`);
    await expect(panel).toContainText(`下次审核时间：${actual.nextReviewAt}`);
    if(expectedAmount!==null)await expect(panel).toContainText(`打款金额：${expectedAmount} 元`);
    const uiFile=info.outputPath(`LIVE-${month}-result-ui.png`);await panel.screenshot({path:uiFile});
    await info.attach('LIVE actual result UI',{path:uiFile,contentType:'image/png'});
    const sourceImage=info.outputPath(`LIVE-${month}-platform.png`);await notePage.screenshot({path:sourceImage,fullPage:false});
    await info.attach('LIVE platform screenshot',{path:sourceImage,contentType:'image/png'});
    await info.attach('LIVE reconciliation receipt',{body:Buffer.from(JSON.stringify({sampleKind:'REAL_PLATFORM_NO_MOCK_NO_ROUTES',contractKind:'ISOLATED_ACCEPTANCE_ONLY_NOT_PRODUCTION_PAYMENT',
      url:safeEvidenceUrl(url),noteId:note.noteId,month,counts:[note.likeCount,note.commentCount,note.favoriteCount],publication:note.publishedAt,source:note.publishedAtSource,
      dataReceipt:note.pageEvidence?.businessDataReceipt,productionRunnerExecuted:useRunner,liveBatchId,runnerDataReceipt:detail.note.businessDataReceipt,
      output:actual,resultId:result.id,xlsxSha256:createHash('sha256').update(bytes).digest('hex'),productionDbAccess:'NONE'},null,2)),contentType:'application/json'});
  } finally { collector.dispose();await notePage.close();if(useRunner&&oldSession)await db.automationSession.update({where:{id:oldSession.id},data:{status:oldSession.status}});await db.topicRule.updateMany({where:{id:{in:defaults.map(r=>r.id)}},data:{status:'ACTIVE'}});await db.$disconnect(); }
});
