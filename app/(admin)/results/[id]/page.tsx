"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Spin } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import AuditDecisionSummary from "@/components/results/AuditDecisionSummary";
import type { ResultDetail } from "@/components/results/types";
import { apiFetch } from "@/lib/client";
import { auditResultLabels } from "@/lib/zh-CN";

interface Product {
  id: string;
  name: string;
  code: string;
}

interface Campaign {
  id: string;
  name: string;
  productId: string;
  month: string;
  products?: Array<{ product: { id: string } }>;
}

export default function ResultDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [form] = Form.useForm();
  const selectedProduct = Form.useWatch("productId", form);

  const load = useCallback(async () => {
    try {
      const [result, productData, campaignData] = await Promise.all([
        apiFetch<ResultDetail>(`/api/results/${params.id}`),
        apiFetch<Product[]>("/api/products"),
        apiFetch<Campaign[]>("/api/campaigns"),
      ]);
      setDetail(result);
      setProducts(productData);
      setCampaigns(campaignData);
    } catch (error) {
      if (error instanceof Error && error.message === "审核结果不存在") {
        message.warning("该审核结果已删除或不存在");
        router.replace("/results");
        return;
      }
      message.error(error instanceof Error ? error.message : "加载详情失败");
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) {
    return (
      <div
        style={{ minHeight: 420, display: "grid", placeItems: "center" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="审核详情"
        description={`${detail.task.product.name} · ${detail.task.campaign.name}`}
        actions={
          <Button
            type="primary"
            icon={<EditOutlined />}
            onClick={() => {
              setReviewOpen(true);
              window.setTimeout(() => {
                form.resetFields();
                form.setFieldsValue({
                  productId: detail.task.product.id,
                  campaignId: detail.task.campaign.id,
                  result: detail.manualReviews[0]?.result || "NEEDS_REVIEW",
                  comment: detail.manualReviews[0]?.comment || "",
                });
              }, 0);
            }}
          >
            人工复核
          </Button>
        }
      />

      <AuditDecisionSummary row={detail} detail={detail} />

      <Modal
        title="人工复核"
        open={reviewOpen}
        onCancel={() => setReviewOpen(false)}
        onOk={() => form.submit()}
        okText="保存复核结论"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            await apiFetch(`/api/results/${detail.id}/review`, {
              method: "POST",
              body: JSON.stringify(values),
            });
            message.success("人工复核已保存，自动审核结果保持不变");
            setReviewOpen(false);
            void load();
          }}
        >
          <Form.Item
            name="productId"
            label="产品归属"
            rules={[{ required: true }]}
          >
            <Select
              options={products.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              onChange={() => form.setFieldValue("campaignId", undefined)}
            />
          </Form.Item>
          <Form.Item
            name="campaignId"
            label="活动归属"
            rules={[{ required: true }]}
          >
            <Select
              options={campaigns
                .filter(
                  (item) =>
                    item.productId === selectedProduct ||
                    item.products?.some(({ product }) => product.id === selectedProduct),
                )
                .map((item) => ({ value: item.id, label: item.name }))}
            />
          </Form.Item>
          <Form.Item
            name="result"
            label="人工审核结果"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: "PASSED", label: auditResultLabels.PASSED },
                { value: "FAILED", label: auditResultLabels.FAILED },
                {
                  value: "NEEDS_REVIEW",
                  label: auditResultLabels.NEEDS_REVIEW,
                },
              ]}
            />
          </Form.Item>
          <Form.Item name="comment" label="人工审核意见">
            <Input.TextArea rows={4} placeholder="说明判断依据或待处理事项" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
