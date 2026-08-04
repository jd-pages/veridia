import { Breadcrumb } from "antd";

export default function PageHeader({
  title,
  description,
  actions,
  breadcrumbItems,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  breadcrumbItems?: string[];
}) {
  return (
    <div className="page-heading">
      <div>
        <Breadcrumb
          items={[
            { title: "笔记合规中心" },
            ...(breadcrumbItems || [title]).map((item) => ({ title: item })),
          ]}
        />
        <h1>{title}</h1>
        <div className="page-kicker">{description}</div>
      </div>
      {actions}
    </div>
  );
}
