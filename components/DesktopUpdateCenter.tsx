"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Modal, Progress, Space, Typography } from "antd";
import { CloudDownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  estimateUpdateSeconds,
  formatUpdateBytes,
  formatUpdateSpeed,
  updateModeLabel,
} from "@/lib/update-download-progress";

function notesAsLines(notes?: string) {
  return (notes || "本次更新包含稳定性改进与问题修复。")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export default function DesktopUpdateCenter() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<VeridiaUpdateStatus>({ state: "idle" });
  const [open, setOpen] = useState(false);
  const api = typeof window === "undefined" ? undefined : window.veridiaDesktop;
  const notes = useMemo(
    () => notesAsLines(status.info?.releaseNotes),
    [status.info?.releaseNotes],
  );
  const remainingSeconds = estimateUpdateSeconds(
    status.transferred,
    status.total,
    status.bytesPerSecond,
  );

  useEffect(() => {
    if (!api) return;
    void api.getUpdateStatus().then(setStatus);
    return api.onUpdateStatus((next) => {
      setStatus(next);
      if (["available", "downloading", "downloaded"].includes(next.state)) {
        setOpen(true);
      }
      if (next.state === "not-available" && next.manual && next.message) {
        message.success(next.message);
      } else if (next.state === "not-available" && next.manual) {
        message.success("当前已是最新版本");
      }
      if (next.state === "error" && next.manual) {
        message.error(`检查更新失败：${next.message || "网络连接异常"}`);
      }
    });
  }, [api, message]);

  if (!api) return null;

  const title =
    status.state === "downloaded"
      ? "新版本已准备完成"
      : status.state === "downloading"
        ? `正在下载 VERIDIA ${status.info?.version || ""}`
        : `发现新版本 ${status.info?.version || ""}`;

  return (
    <Modal
      open={open}
      title={title}
      width={560}
      closable={status.state !== "downloading"}
      maskClosable={status.state !== "downloading"}
      onCancel={() => setOpen(false)}
      footer={
        status.state === "available"
          ? [
              <Button key="later" onClick={() => setOpen(false)}>
                稍后提醒
              </Button>,
              <Button
                key="download"
                type="primary"
                icon={<CloudDownloadOutlined />}
                onClick={() => void api.downloadUpdate()}
              >
                立即更新
              </Button>,
            ]
          : status.state === "downloaded"
            ? [
                <Button key="later" onClick={() => setOpen(false)}>
                  稍后重启
                </Button>,
                <Button
                  key="install"
                  type="primary"
                  icon={<ReloadOutlined />}
                  onClick={() => void api.installUpdate()}
                >
                  重启并安装
                </Button>,
              ]
            : []
      }
    >
      {status.state === "downloading" ? (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Progress percent={status.percent || 0} status="active" />
          <Typography.Text>
            已下载：{formatUpdateBytes(status.transferred)} / {formatUpdateBytes(status.total)}
          </Typography.Text>
          <Typography.Text>
            速度：{formatUpdateSpeed(status.bytesPerSecond)}
          </Typography.Text>
          <Typography.Text>
            预计剩余：{remainingSeconds === null ? "计算中" : `${remainingSeconds} 秒`}
          </Typography.Text>
          <Typography.Text>
            当前方式：{updateModeLabel(status.downloadMode)}
          </Typography.Text>
          <Typography.Text type="secondary">
            下载完成后会询问是否重启安装，不会中断当前审核。
          </Typography.Text>
        </Space>
      ) : status.state === "downloaded" ? (
        <Typography.Paragraph>
          新版本已下载并校验完成。重启 VERIDIA 后将自动安装，用户数据库和小红书登录会话不会被覆盖。
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Paragraph strong>更新内容：</Typography.Paragraph>
          <Space direction="vertical" size={6}>
            {notes.map((line, index) => (
              <Typography.Text key={`${line}-${index}`}>• {line}</Typography.Text>
            ))}
          </Space>
        </>
      )}
    </Modal>
  );
}
