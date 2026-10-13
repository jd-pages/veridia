"use client";
import { useState } from "react";
import { Button, Card, Form, Input, Select, Space, Switch, Tag, Typography, type FormInstance } from "antd";

export interface StoreBrandPolicyFormValue {
  brandName: string;
  contentChannel: string;
  requireStoreTopic: boolean;
  useSharedTemplate: boolean;
  acceptedTopics: string[];
  requiredTopics: string[];
  reviewStatus: string;
}

export default function StoreBrandPolicyFields({ form, brands }: { form: FormInstance; brands: string[] }) {
  const [channel, setChannel] = useState("XIAOHONGSHU");
  const policies: StoreBrandPolicyFormValue[] = Form.useWatch("brandPolicies", form) || [];
  const enable = (index: number, required: boolean) => {
    form.setFieldValue(["brandPolicies", index, "requireStoreTopic"], required);
    form.setFieldValue(["brandPolicies", index, "reviewStatus"], "CONFIRMED");
    if (required && !(form.getFieldValue("acceptedTopics") || []).length) {
      form.setFieldValue("acceptedTopics", [{ topic: form.getFieldValue("storeName") || "", enabled: true }]);
    }
  };
  return <Space direction="vertical" style={{ width: "100%" }}>
    <Typography.Title level={5}>店铺 × 品牌审核配置</Typography.Title>
    <Select aria-label="品牌政策内容渠道" value={channel} onChange={setChannel}
      options={[{ value: "XIAOHONGSHU", label: "小红书" }, { value: "DOUYIN", label: "抖音" }]} />
    <Typography.Text type="secondary">品牌按当前系统数据加载；未确认关联只标记待确认，不继承其它品牌要求。抖音仍只审核可接受话题，小红书审核任选其一＋全部必需话题。</Typography.Text>
    <Select mode="multiple" aria-label="需要店铺话题审核的品牌" style={{ width: "100%" }}
      options={[...new Set([...brands, ...policies.map(policy => policy.brandName)])].map(value => ({ value, label: value }))}
      value={policies.filter(policy => policy.contentChannel === channel && policy.requireStoreTopic).map(policy => policy.brandName)}
      onChange={(selected: string[]) => { policies.forEach((policy, index) => {
        if (policy.contentChannel === channel && policy.requireStoreTopic !== selected.includes(policy.brandName)) enable(index, selected.includes(policy.brandName));
      }); }} />
    <Form.List name="brandPolicies">{fields => fields.map(field => {
      const policy = policies[field.name];
      if (!policy) return null;
      return <Card key={field.key} size="small" title={policy.brandName} style={{ display: policy.contentChannel === channel ? undefined : "none" }}
        data-testid={`store-brand-policy-${policy.brandName}-${policy.contentChannel}`}>
        <Form.Item name={[field.name, "brandName"]} hidden><Input /></Form.Item>
        <Form.Item name={[field.name, "contentChannel"]} hidden><Input /></Form.Item>
        <Form.Item name={[field.name, "reviewStatus"]} hidden><Input /></Form.Item>
        {policy.reviewStatus === "PENDING_REVIEW" ? <Space><Tag color="orange">待管理员确认</Tag><Button size="small" onClick={() => enable(field.name, false)}>确认不要求</Button></Space> : null}
        <Form.Item name={[field.name, "requireStoreTopic"]} label="要求店铺话题审核" valuePropName="checked">
          <Switch checkedChildren="要求" unCheckedChildren="不要求" onChange={required => enable(field.name, required)} />
        </Form.Item>
        {policy.requireStoreTopic ? <>
          <Form.Item name={[field.name, "useSharedTemplate"]} label="使用店铺共用话题模板" valuePropName="checked"><Switch /></Form.Item>
          {!policy.useSharedTemplate ? <>
            <Form.Item name={[field.name, "acceptedTopics"]} label="品牌可接受话题（任选其一）"><Select mode="tags" aria-label={`${policy.brandName}可接受话题`} open={false} /></Form.Item>
            <Form.Item name={[field.name, "requiredTopics"]} label="品牌附加必需话题（全部满足）"><Select mode="tags" aria-label={`${policy.brandName}必需话题`} open={false} /></Form.Item>
          </> : <Typography.Text type="secondary">使用上方共用模板；共用模板为空时不能保存“要求”。</Typography.Text>}
        </> : <Typography.Text type="secondary">不要求话题；Canonical、Alias 和成交平台映射仍有效。</Typography.Text>}
      </Card>;
    })}</Form.List>
  </Space>;
}
