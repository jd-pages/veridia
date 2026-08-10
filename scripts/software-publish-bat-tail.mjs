import process from "node:process";

const outcome = process.argv[2];
if (outcome === "success") {
  process.stdout.write("VERIDIA 发布入口已正常结束。\n本次未执行 rules:publish，本次未发布远程规则。\n");
} else if (outcome === "failure") {
  process.stdout.write("VERIDIA 正式发布未完成，请根据上方中文错误摘要和日志处理。\n没有自动重试、reset、覆盖 Tag，也没有执行 rules:publish。\n");
} else {
  process.stderr.write("BAT 收尾状态无效。\n");
  process.exitCode = 2;
}
