import { Breadcrumb } from "antd";

export default function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <Breadcrumb items={[{ title: "笔记合规中心" }, { title }]} />
        <h1>{title}</h1>
        <div className="page-kicker">{description}</div>
      </div>
      {actions}
    </div>
  );
}
