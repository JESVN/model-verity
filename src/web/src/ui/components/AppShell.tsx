import type { ReactNode, Ref } from "react";
import type { NavId } from "../types";
import { Atmosphere } from "./Atmosphere";

export interface AppShellProps {
  brand?: string;
  badge?: string;
  activeNav: NavId;
  onNav?: (id: NavId) => void;
  topRight?: ReactNode;
  children: ReactNode;
  hideSidebar?: boolean;
  mainRef?: Ref<HTMLElement>;
  navStatus?: Partial<Record<NavId, { label: string; tone: "running" | "done" | "attention" }>>;
}

const NAV: { id: NavId; label: string }[] = [
  { id: "verify", label: "验证" },
  { id: "providers", label: "供应商" },
  { id: "references", label: "参考样本" },
  { id: "history", label: "历史" },
];

export function AppShell({
  brand = "model-verity",
  badge,
  activeNav,
  onNav,
  topRight,
  children,
  hideSidebar,
  mainRef,
  navStatus,
}: AppShellProps) {
  return (
    <>
      <Atmosphere />
      <div className="shell">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="brand-mark" aria-hidden>
              mv
            </span>
            <span>{brand}</span>
            {badge ? <span className="topbar-badge">{badge}</span> : null}
          </div>
          <div className="topbar-actions">
            {topRight ?? <span>本地 · 127.0.0.1</span>}
          </div>
        </header>
        <div className="shell-body">
          {!hideSidebar ? (
            <aside className="sidebar">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${activeNav === item.id ? " is-active" : ""}`}
                  onClick={() => onNav?.(item.id)}
                >
                  <span>{item.label}</span>
                  {navStatus?.[item.id] ? <span className={`nav-status tone-${navStatus[item.id]!.tone}`} aria-label={navStatus[item.id]!.label}>{navStatus[item.id]!.label}</span> : null}
                </button>
              ))}
              <div className="sidebar-foot">
                结构化证据存储
                <br />
                密钥加密保护
              </div>
            </aside>
          ) : null}
          <main className="main" ref={mainRef}>
            <div className="main-inner">{children}</div>
          </main>
        </div>
      </div>
    </>
  );
}
