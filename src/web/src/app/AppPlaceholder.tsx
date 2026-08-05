import { AppShell, SetupPanel } from "@ui/index";
import type { SetupView } from "@ui/types";

/** Real app shell — business wiring only after 界面验收 Approved. */
const emptySetup: SetupView = {
  providers: [],
  references: [],
  selectedProviderId: null,
  selectedModel: null,
  claimedModel: "",
  selectedReferenceId: null,
  profile: "audit",
  estimatedRequests: 120,
  estimatedMinutes: 3,
  canStart: false,
  disabledReason: "业务逻辑尚未接线。请使用 Preview Lab 验收 UI：/ 或 npm run preview:ui",
};

export function AppPlaceholder() {
  return (
    <AppShell activeNav="verify" badge="DEV">
      <SetupPanel data={emptySetup} readOnly />
      <p className="caption" style={{ marginTop: 16, textAlign: "center" }}>
        UI 门禁见 <code>docs/界面验收.md</code>。预览场景请打开开发服务器根路径（当前默认进入
        Preview）。
      </p>
    </AppShell>
  );
}
