import type { V2Conclusion } from "./types.js";

export const EXPLORATORY_POLICY_VERSION = "exploratory-only@1";

/** Production policy until independently frozen calibration satisfies release gates. */
export function enforceExploratoryPolicy(conclusion: V2Conclusion): V2Conclusion {
  const originalStatus = conclusion.behavior.status;
  const observed = originalStatus === "supported"
    ? { status: "compatible_signal", label: "观察到行为相容迹象", detail: "当前时点的行为距离较低；现有证据不足以提供固定错误率保证。" }
    : originalStatus === "anomalous"
      ? { status: "deviation_signal", label: "观察到行为偏移", detail: "当前时点相对参考存在行为偏移；不能据此认定模型替换。" }
      : conclusion.behavior;
  return {
    ...conclusion,
    policyVersion: EXPLORATORY_POLICY_VERSION,
    behavior: observed,
    strongConclusion: false,
    summary: observed.status === "compatible_signal"
      ? "当前时点观察到行为相容迹象；该结果不是模型身份认证。"
      : observed.status === "deviation_signal"
        ? "当前时点观察到相对参考的行为偏移；需要复核原因。"
        : conclusion.summary,
    limitations: [...new Set([
      ...conclusion.limitations,
      "当前证据不足以输出“行为支持”或“明显异常”等确定性结论。",
      "不提供固定错误率保证。",
      "长期稳定性未评估，不代表未来持续表现。",
    ])],
  };
}
