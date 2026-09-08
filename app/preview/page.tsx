"use client";

import { useEffect, useRef, useState } from "react";

export default function PreviewBootstrapPage() {
  const started = useRef(false);
  const [message, setMessage] = useState("正在打开本地预览…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const nonce = new URLSearchParams(window.location.hash.slice(1)).get("nonce");
    // The capability never enters a query string, server log or referrer.
    window.history.replaceState(null, "", "/preview");
    if (!nonce) {
      window.location.replace("/dashboard");
      return;
    }
    void fetch("/api/auth/preview-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "本地预览登录失败。");
      window.location.replace("/dashboard");
    }).catch(() => {
      setMessage("本地预览登录失败，请重新运行预览启动入口。");
    });
  }, []);

  return <main style={{ padding: 48 }} role="status">{message}</main>;
}
