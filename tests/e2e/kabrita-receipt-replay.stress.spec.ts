import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { importApprovedAuditReceipts } from "../helpers/real-audit-receipt-fixture";
import { collectXhsInteractionMetrics } from "../../lib/interaction-metrics";

test("approved real October receipts: unchanged legacy contracts, content and downloaded 17-column output", async ({ page }, info) => {
  test.setTimeout(120_000);
  if (!process.env.VERIDIA_APPROVED_RECEIPTS) throw Error("PRIVATE_APPROVED_RECEIPTS_REQUIRED_NOT_A_SYNTHETIC_ACCEPTANCE");
  const url = process.env.E2E_DATABASE_URL!;
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const imported = await importApprovedAuditReceipts(db);
    expect((await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).ok()).toBeTruthy();
    await db.automationSession.updateMany({ where: { platform: "XIAOHONGSHU" }, data: { status: "UNKNOWN" } });
    const snapshot = async () => db.auditResult.findMany({ select: { id: true, ruleSnapshot: true, retentionStatus: true,
      retentionDueAt: true, extractionRecord: { select: { rawData: true } } }, orderBy: { id: "asc" } });
    const before = await snapshot();
    const latest = new Map<string, { id: string; auditedAt: number }>();
    for (const result of imported.source.data.results) {
      const extraction = imported.source.data.extractions.find(e => e.id === result.extractionRecordId)!;
      const note = JSON.parse(String(extraction.rawData));
      if (!latest.has(note.noteId) || latest.get(note.noteId)!.auditedAt < Number(result.auditedAt)) latest.set(note.noteId, { id: result.id, auditedAt: Number(result.auditedAt) });
    }
    const details = [];
    for (const [noteId, result] of latest) {
      const response = await page.request.get(`/api/results/${result.id}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      const detail = (await response.json()).data;
      expect(detail.task.campaign.id).toBe(imported.source.data.campaigns[0].id);
      expect(JSON.parse(detail.ruleSnapshot).rewardMode).toBe("LEGACY");
      expect(detail.presentation.kabrita.payoutAmount).toBeNull();
      details.push({ noteId, id: result.id, ...detail.presentation.kabrita });
    }
    const selected = [...latest.values()].map(r => r.id);
    const response = await page.request.get(`/api/results/export?format=xlsx&ids=${selected.join(",")}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const bytes = await response.body(), file = info.outputPath("actual-real-october-17-columns.xlsx");
    await writeFile(file, bytes); await info.attach("actual real-record XLSX", { path: file, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const workbook = new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("佳贝艾特审核结果")!;
    expect(sheet.columnCount).toBe(17);expect(sheet.getCell("M1").value).toBe("是否符合");expect(sheet.getCell("P1").value).toBe("打款金额");
    expect(sheet.rowCount).toBe(latest.size + 1);
    for (const [index, detail] of details.entries()) {
      const row = Array.from({length:latest.size}, (_,i)=>sheet.getRow(i+2)).find(row=>String(row.getCell(11).value).includes(detail.noteId));
      // Short-link rows retain the original short URL: use the exact result-bound task URL.
      const sourceResult = imported.source.data.results.find(r=>r.id===detail.id)!;
      const task = imported.source.data.tasks.find(t=>t.id===sourceResult.auditTaskId)!;
      const actual = row || Array.from({length:latest.size}, (_,i)=>sheet.getRow(i+2)).find(row=>String(row.getCell(11).value)===task.url)!;
      expect(actual, `result ${index}: matching original URL`).toBeTruthy();
      expect(actual.getCell(13).value).toBe(detail.complianceResult);
      expect(actual.getCell(15).value).toBe(detail.interactionTotal ?? "待确认");
      expect(actual.getCell(16).value).toBe(detail.payoutState);
      if (/^\d{4}-\d{2}-\d{2}$/u.test(detail.nextReviewAt)) expect(actual.getCell(17).value).toEqual(new Date(detail.nextReviewAt+"T00:00:00Z"));
      else expect(actual.getCell(17).value).toBe(detail.nextReviewAt);
    }
    const csv = await page.request.get(`/api/results/export?format=csv&ids=${selected.join(",")}`);
    expect(csv.ok()).toBeTruthy();const csvText=await csv.text();await writeFile(info.outputPath("actual-real-october.csv"),csvText);
    expect(csvText).toContain("打款金额");
    for(const detail of details)expect(csvText).toContain(detail.payoutState);
    await page.goto("/results?startDate=2020-01-01&endDate=2099-12-31");
    const known = details.find(d=>d.interactionTotal===42)!;
    const ui = page.locator(`.ant-table-row[data-row-key="${known.id}"]`);
    await expect(ui).toContainText("互动量：42");await expect(ui).toContainText("旧版奖励合同");
    const oldContractPanel=ui.getByLabel("佳贝艾特审核与打款");
    await oldContractPanel.scrollIntoViewIfNeeded();
    await oldContractPanel.screenshot({path:info.outputPath("real-october-ui.png")});
    expect(await snapshot()).toEqual(before);
    await info.attach("real-receipt-reconciliation",{body:Buffer.from(JSON.stringify({sampleKind:"AUTHORIZED_DEIDENTIFIED_REAL_DATABASE_RECEIPTS_NOT_NEW_CAMPAIGN",productionDatabaseWrites:0,
      sourceInputSha256:imported.source.inputSha256,sourceCampaignId:imported.source.data.campaigns[0].id,sourceMode:"LEGACY",formalActivation:"BLOCKED_NOT_APPLIED",
      workbookSha256:createHash("sha256").update(bytes).digest("hex"),historicalSnapshotsUnchanged:true,rows:details})),contentType:"application/json"});

    // Candidate activation happens ONLY in this owned clone of the actual
    // Campaign. It is a preparation receipt, never a production rule release.
    const candidate = { rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: false,
      baseRewardAmount: 50, interactionRewardTiers: [{threshold:10,amount:20},{threshold:40,amount:50}], retentionDays: 30 };
    const campaignId=imported.source.data.campaigns[0].id;
    const configured=await page.request.put(`/api/campaigns/${campaignId}`,{data:candidate});
    expect(configured.ok(),await configured.text()).toBeTruthy();
    const noteIds=[...details.filter(row=>row.interactionTotal===null&&row.complianceResult==="Y").slice(0,3).map(row=>row.noteId),
      details.find(row=>row.interactionTotal===13)!.noteId,details.find(row=>row.interactionTotal===42)!.noteId];
    expect(new Set(noteIds).size).toBe(5);
    const expectedTotals=[0,null,null,13,42],expectedPayouts=[50,null,null,70,100],newIds:string[]=[],reconciliation=[];
    const domPage=await page.context().newPage();
    try{
      for(const [index,noteId] of noteIds.entries()){
        const originalId=latest.get(noteId)!.id;
        const original=imported.source.data.results.find(r=>r.id===originalId)!;
        const oldTask=await db.auditTask.findUniqueOrThrow({where:{id:String(original.auditTaskId)}});
        const evidence=imported.source.data.extractions.find(e=>e.id===original.extractionRecordId)!;
        const extraction=JSON.parse(String(evidence.rawData));
        const metrics=extraction.pageEvidence.interactionEvidence;
        if(metrics.status!=="SUCCESS"){
          // Reconstruct only the exact class/icon/count shape recorded by the
          // authorized extraction. This proves parser behavior, not fresh data.
          const order=["LIKE","FAVORITE","COMMENT"];
          const controls=order.map(kind=>metrics.candidates.find((c:{kindHint:string;source?:string})=>c.kindHint===kind&&c.source?.startsWith("DOM_CURRENT_NOTE_ACTION_BAR")));
          if(controls.every(Boolean)){
          const escape=(s:string)=>s.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");
          const html=controls.map(c=>`<span class="${escape(c.controlClass)}"><svg width="24" height="24"><use href="${escape(c.iconHref)}"></use></svg><span class="count">${escape(c.countNodeText||"")}</span></span>`).join("");
          await domPage.setContent(`<article id="noteContainer"><div class="buttons engage-bar-style"><div class="left">${html}</div></div></article>`);
          const replay=await collectXhsInteractionMetrics(domPage,"#noteContainer",{extractionReady:true});
          expect(replay.status).toBe("SUCCESS");
          Object.assign(extraction,{likeCount:replay.likeCount,commentCount:replay.commentCount,favoriteCount:replay.favoriteCount,interactionExtractionStatus:replay.status});
          }
        }
        const task=await db.auditTask.create({data:{url:oldTask.url,normalizedUrl:oldTask.normalizedUrl,
          productId:oldTask.productId,campaignId:oldTask.campaignId,channel:oldTask.channel,platform:oldTask.platform,
          source:"EXCEL",status:"PENDING",storeName:oldTask.storeName,commercePlatform:oldTask.commercePlatform,
          notes:oldTask.notes}});
        const {auditEvidenceVersion:_version,auditTaskEvidence:_taskEvidence,...payload}=extraction;
        void _version;void _taskEvidence;
        payload.extractedAt=new Date().toISOString();
        payload.pageEvidence={...payload.pageEvidence,customerReceiptReplay:{sourceResultId:originalId,
          sourceRawDataSha256:evidence.sourceRawDataSha256,sourceCapturedAt:extraction.extractedAt,
          kind:"ISOLATED_HISTORICAL_RECEIPT_REPLAY_NOT_NEW_PLATFORM_CAPTURE",candidateContractOnly:true}};
        const audited=await page.request.post(`/api/tasks/${task.id}/audit`,{data:{extraction:payload}});
        expect(audited.ok(),await audited.text()).toBeTruthy();const fresh=(await audited.json()).data;newIds.push(fresh.id);
        const detail=(await(await page.request.get(`/api/results/${fresh.id}`)).json()).data;
        expect(detail.presentation.kabrita).toMatchObject({complianceResult:"Y",interactionTotal:expectedTotals[index],payoutAmount:expectedPayouts[index],payoutState:expect.stringContaining(expectedPayouts[index]===null?"待确认":"非已付款")});
        expect(detail.presentation.kabrita.payoutState).toContain(expectedPayouts[index]===null?"互动数据未完整获取":"待复核");
        expect(JSON.parse(detail.ruleSnapshot)).toMatchObject(candidate);
        reconciliation.push({noteId,sourceResultId:originalId,newIsolatedResultId:fresh.id,sourceRuleSnapshotSha256:original.sourceRuleSnapshotSha256,
          total:expectedTotals[index],payout:expectedPayouts[index],nextReviewAt:detail.presentation.kabrita.nextReviewAt,
          payoutState:detail.presentation.kabrita.payoutState,
          formalContractActivated:false,acquisitionSource:metrics.status==="SUCCESS"?"ORIGINAL_BOUND_STRUCTURED_RECEIPT"
            :expectedTotals[index]===null?"PARTIAL_HISTORICAL_CONTROL_SHAPE_FRESH_CAPTURE_REQUIRED":"RECORDED_DOM_SHAPE_REPLAY_NOT_LIVE"});
      }
    }finally{await domPage.close();}
    const candidateResponse=await page.request.get(`/api/results/export?format=xlsx&ids=${newIds.join(",")}`);
    expect(candidateResponse.ok()).toBeTruthy();const candidateBytes=await candidateResponse.body();
    const candidateFile=info.outputPath("CANDIDATE_ONLY-real-five-row-17-columns.xlsx");await writeFile(candidateFile,candidateBytes);
    await info.attach("candidate contract five-row XLSX NOT production",{path:candidateFile,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    const candidateBook=new ExcelJS.Workbook();await candidateBook.xlsx.load(candidateBytes as unknown as ExcelJS.Buffer);
    const candidateSheet=candidateBook.getWorksheet("佳贝艾特审核结果")!;expect(candidateSheet.columnCount).toBe(17);expect(candidateSheet.rowCount).toBe(6);
    for(const [index,record] of reconciliation.entries()){
      const task=await db.auditTask.findUniqueOrThrow({where:{id:(await db.auditResult.findUniqueOrThrow({where:{id:record.newIsolatedResultId}})).auditTaskId}});
      const row=Array.from({length:5},(_,i)=>candidateSheet.getRow(i+2)).find(row=>row.getCell(11).value===task.url)!;
      expect(row.getCell(13).value).toBe("Y");expect(row.getCell(15).value).toBe(expectedTotals[index]??"待确认");expect(row.getCell(16).value).toBe(expectedPayouts[index]??"待确认：互动数据未完整获取");
      expect(row.getCell(17).value).toEqual(new Date(record.nextReviewAt+"T00:00:00Z"));
    }
    const candidateCsv=await page.request.get(`/api/results/export?format=csv&ids=${newIds.join(",")}`);
    expect(candidateCsv.ok()).toBeTruthy();const candidateCsvText=await candidateCsv.text();
    await writeFile(info.outputPath("CANDIDATE_ONLY-real-five-row.csv"),candidateCsvText);
    for(const row of reconciliation)expect(candidateCsvText).toContain(`,${row.total??"待确认"},${row.payout===null?row.payoutState:`${row.payout}（${row.payoutState}）`},${row.nextReviewAt}`);
    await page.reload();const finalUi=page.locator(`.ant-table-row[data-row-key="${newIds[4]}"]`);
    await expect(finalUi).toContainText("互动量：42");await expect(finalUi).toContainText("打款金额：100 元");await expect(finalUi).toContainText("非已付款");
    for(const [index,record] of reconciliation.entries()){
      const panel=page.locator(`.ant-table-row[data-row-key="${newIds[index]}"]`).getByLabel("佳贝艾特审核与打款");
      await expect(panel).toContainText("是否符合：Y");
      await expect(panel).toContainText(`互动量：${record.total??"待确认"}`);
      await expect(panel).toContainText(`打款金额：${record.payout===null?record.payoutState:`${record.payout} 元`}`);
      await expect(panel).toContainText(`下次审核时间：${record.nextReviewAt}`);
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({path:info.outputPath(`CANDIDATE_ONLY-row-${index+1}-ui.png`)});
    }
    await finalUi.getByLabel("佳贝艾特审核与打款").screenshot({path:info.outputPath("CANDIDATE_ONLY-real-five-row-ui.png")});
    const after=await snapshot();expect(after.filter(row=>before.some(old=>old.id===row.id))).toEqual(before);
    await info.attach("candidate-five-real-record-reconciliation",{body:Buffer.from(JSON.stringify({sampleKind:"REAL_RECEIPTS_WITH_EXPLICIT_ISOLATED_CANDIDATE_CONTRACT_NOT_PRODUCTION",candidate,
      productionDatabaseWrites:0,formalActivation:"NOT_APPLIED",platformFreshCapture:"BLOCKED_IP_RISK",historicalSnapshotsUnchanged:true,rows:reconciliation})),contentType:"application/json"});
  } finally { await db.$disconnect(); }
});
