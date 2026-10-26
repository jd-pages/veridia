"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";

/** App-open scheduling only. No service running after logout/app close, no
 * concurrent scans, no repeated request while an earlier one is unsettled. */
export default function ResultFollowUpMonitor({ enabled }: { enabled: boolean }) {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true, pending = false;
    const scan = async () => {
      if (!active || pending || document.hidden) return;
      pending = true;
      try {
        const result = await apiFetch<{ status: string }>("/api/results/follow-up", { method: "POST" });
        if (active) setNotice(result.status === "QUEUED"
          ? "已自动安排业务数据补采，可在审核任务中查看、暂停或取消。复核日期仅供人工安排，不自动创建留存复核任务。"
          : result.status === "LOGIN_RECOVERY_REQUIRED"
            ? "自动补采等待小红书会话就绪：请到审核任务恢复正常登录并检测会话；验证恢复后自动继续，不绕过登录或安全验证。"
            : null);
      } catch {
        if (active) setNotice("自动补采检查未完成，请在审核任务中查看会话与任务状态；未修改原审核结果。");
      } finally { pending = false; }
    };
    void scan();
    const timer = window.setInterval(() => { void scan(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  return notice ? <div role="status" style={{ padding: "8px 24px", fontSize: 12 }}>{notice}</div> : null;
}
