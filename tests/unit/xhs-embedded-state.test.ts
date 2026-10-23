import { describe, it, expect } from "vitest";
import { parseXhsEmbeddedState } from "@/lib/automation/xhs-embedded-state";
import { collectJsonCandidates } from "@/lib/automation/xhs-page-evidence";
const id = "6ab4caf7000000001801405c";
describe("XHS safe data-only embedded state parser", () => {
  it("current serializer Map/Set/undefined do not discard matched note business data", () => {
    const script = `window.__INITIAL_STATE__={"comment":{"cache":new Map([]),"ids":new Set([])},"unused":undefined,"note":{"noteDetailMap":{"${id}":{"note":{"noteId":"${id}","time":1790236149000,"lastUpdateTime":1790233336000,"desc":"literal undefined new Map([])","interactInfo":{"likedCount":"234","collectedCount":"222","commentCount":"23"}}}}}};`;
    const data = parseXhsEmbeddedState(script);
    expect(data).toMatchObject({ unused: null, note: { noteDetailMap: { [id]: { note: { desc: "literal undefined new Map([])" } } } } });
    const candidates = collectJsonCandidates(data);
    expect(candidates.interactionCandidates.map((value) => Number(value.valueText)).sort((a,b)=>a-b)).toEqual([23,222,234]);
    expect(candidates.publishedAtCandidates).toEqual([expect.objectContaining({ contentId: id, source: "PAGE_JSON:time", value: new Date(1790236149000).toISOString() })]);
  });
  it.each([
    'window.__INITIAL_STATE__=(()=>{throw new Error("execute")})()',
    'window.__INITIAL_STATE__={"time":Date.now()}',
    'window.__INITIAL_STATE__={"x":new Date()}',
    'window.__INITIAL_STATE__={};evil()',
    'window.__INITIAL_STATE__={"a":1,"a":2}',
    'window.__INITIAL_STATE__={"x":undefinedSuffix}',
    'window.__INITIAL_STATE__={"x":new Map([["a",1],["a",2]])}',
  ])("rejects executable/ambiguous syntax without evaluating it: %s", (script) => {
    expect(parseXhsEmbeddedState(script)).toBeNull();
  });
  it("protects length/depth budgets and prototype keys remain inert data", () => {
    expect(parseXhsEmbeddedState('"' + "x".repeat(4_000_000) + '"')).toBeNull();
    expect(parseXhsEmbeddedState("[".repeat(82)+"0"+"]".repeat(82))).toBeNull();
    const inert = parseXhsEmbeddedState('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(inert)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(inert, "__proto__")?.value.polluted).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
