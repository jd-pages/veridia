import { describe, expect, it } from "vitest";
import { collectJsonCandidates, createEmptyCandidates, mergeCandidates } from "@/lib/automation/xhs-page-evidence";
import { isSameXhsNoteNavigation, resolveXhsBusinessEvidence } from "@/lib/automation/xhs-business-evidence";
import { resolveInteractionMetrics } from "@/lib/interaction-metrics";

const id = "6a7d71e60000000035014e8f", other = "6a7d71e60000000035014e80";
const now = "2026-10-23T00:00:00.000Z";
const payload = (noteId = id, time: unknown = 1_786_000_000) => ({ data: { items: [{ id: noteId, note_card: {
  note_id: noteId, title: "current note", time,
  interact_info: { liked_count: "9", comment_count: "0", collected_count: "4" },
} }] } });
const resolve = (candidates = createEmptyCandidates()) => resolveXhsBusinessEvidence({
  noteId: id, candidates, domMetrics: resolveInteractionMetrics([]), normal: true, collectedAt: now,
});

describe("XHS current-note business evidence", () => {
  const navigation = {
    beforeUrl: `https://www.xiaohongshu.com/discovery/item/${id}?share=1`,
    afterUrl: `https://www.xiaohongshu.com/explore/${id}?source=share`,
    observedUrl: `https://www.xiaohongshu.com/explore/${id}`,
    noteId: id, rootNoteId: id, normal: true, scopeReady: true,
  };
  it("same-note discovery-to-explore navigation preserves strict scoped identity", () => {
    expect(isSameXhsNoteNavigation(navigation)).toBe(true);
    expect(isSameXhsNoteNavigation({ ...navigation, rootNoteId: null, observedUrl: navigation.beforeUrl })).toBe(true);
  });
  it.each([
    { afterUrl: `https://www.xiaohongshu.com/explore/${other}` },
    { observedUrl: `https://www.xiaohongshu.com/explore/${other}` },
    { afterUrl: `https://attacker.example/explore/${id}` },
    { afterUrl: `https://xiaohongshu.com/explore/${id}` },
    { afterUrl: `https://www.xiaohongshu.com/user/profile/${id}` },
    { afterUrl: `https://www.xiaohongshu.com/website-login/error?note_id=${id}` },
    { afterUrl: "https://www.xiaohongshu.com/explore" },
    { afterUrl: `https://www.xiaohongshu.com/explore/${id}?note_id=${other}` },
    { beforeUrl: `https://www.xiaohongshu.com:8443/explore/${id}`, afterUrl: `https://www.xiaohongshu.com:8443/explore/${id}`, observedUrl: `https://www.xiaohongshu.com:8443/explore/${id}` },
    { rootNoteId: other }, { noteId: null }, { scopeReady: false }, { normal: false },
  ])("canonical navigation rejects unproved identity or state %j", (change) => {
    expect(isSameXhsNoteNavigation({ ...navigation, ...change })).toBe(false);
  });
  it("NETWORK current-note counters include real zero and preserve receipt, not recommendation counts", () => {
    const result = resolve(mergeCandidates(collectJsonCandidates(payload(other), "NETWORK_JSON"), collectJsonCandidates(payload(), "NETWORK_JSON")));
    expect(result.metrics).toMatchObject({ status: "SUCCESS", likeCount: 9, commentCount: 0, favoriteCount: 4, totalCount: 13 });
    expect(result.publication).toMatchObject({ contentId: id, source: "NETWORK_JSON:time" });
    expect(result.receipt).toMatchObject({ noteId: id, collectedAt: now, blockers: [] });
    expect(result.receipt.interaction.sources.every((candidate) => candidate.contentId === id)).toBe(true);
  });
  it("embedded noteDetailMap fallback works without network or explicit note id on wrapper", () => {
    const card = payload().data.items[0].note_card;
    const result = resolve(collectJsonCandidates({ note: { noteDetailMap: { [id]: { note: card } } } }));
    expect(result.metrics.totalCount).toBe(13);
    expect(result.publication?.source).toBe("PAGE_JSON:time");
  });
  it("user/comment/recommend timestamps and counters cannot inherit note identity", () => {
    const candidates = collectJsonCandidates({ note_id: id, user: { id: other, create_time: 1_800_000_000,
      interact_info: { liked_count: 99, comment_count: 99, collected_count: 99 } },
    comments: [{ note_id: id, create_time: 1_800_000_000, interact_info: { liked_count: 99 } }],
    recommend: [payload().data.items[0]], last_update_time: 1_800_000_000 });
    expect(candidates.publishedAtCandidates).toEqual([]);
    expect(candidates.interactionCandidates).toEqual([]);
    expect(resolve(candidates).metrics.totalCount).toBeNull();
  });
  it("structured data has priority over abbreviated DOM counters without substituting a different note", () => {
    const result = resolveXhsBusinessEvidence({ noteId: id, candidates: collectJsonCandidates(payload(), "NETWORK_JSON"),
      domMetrics: resolveInteractionMetrics([{ kindHint: "LIKE", valueText: "1万", source: "DOM_CURRENT_NOTE_ACTION_BAR",
        controlClass: "like-wrapper like-active", iconHref: "#like_b", countNodePresent: true, countNodeText: "1万" }]),
      normal: true, collectedAt: now });
    expect(result.metrics.totalCount).toBe(13);
    expect(result.receipt.interaction.domSources).toEqual([expect.objectContaining({
      kind: "LIKE", value: "1万", contentId: id, controlClass: "like-wrapper like-active",
      iconHref: "#like_b", countNodePresent: true, countNodeText: "1万",
    })]);
    expect(result.receipt.interaction.sources.every(source => source.source?.startsWith("NETWORK_JSON") === true)).toBe(true);
  });
  it.each([undefined, null, "", "待确认", "12+", -1, 2_147_483_648])("unknown/invalid count %s is never manufactured as zero", (value) => {
    const data = payload();
    Object.assign(data.data.items[0].note_card.interact_info, { liked_count: value });
    const result = resolve(collectJsonCandidates(data));
    expect(result.metrics.status).toBe("UNAVAILABLE");
    expect(result.metrics.totalCount).toBeNull();
  });
  it("same-priority conflicting current-note time/counters fail closed with actionable blockers", () => {
    const second = payload(id, 1_786_100_000);
    second.data.items[0].note_card.interact_info.liked_count = "10";
    const result = resolve(mergeCandidates(collectJsonCandidates(payload()), collectJsonCandidates(second)));
    expect(result.metrics.totalCount).toBeNull();
    expect(result.publication).toBeNull();
    expect(result.receipt.blockers).toEqual(["INTERACTION_COUNT_CONFLICT", "PUBLISHED_TIME_CONFLICT"]);
  });
  it("no matching identity or inaccessible page cannot use any business values", () => {
    const candidates = collectJsonCandidates(payload(other));
    expect(resolve(candidates).metrics.totalCount).toBeNull();
    const blocked = resolveXhsBusinessEvidence({ noteId: id, candidates: collectJsonCandidates(payload()),
      domMetrics: resolveInteractionMetrics([]), normal: false, collectedAt: now });
    expect(blocked.metrics.totalCount).toBeNull();
    expect(blocked.publication).toBeNull();
  });
});
