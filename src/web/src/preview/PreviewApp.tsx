import { useEffect, useMemo, useState } from "react";
import {
  AppShell,
  HistoryPage,
  ProvidersPage,
  ReferencesPage,
  ResultPanel,
  RunningPanel,
  SetupPanel,
} from "@ui/index";
import type { NavId, PreviewSceneId } from "@ui/types";
import { history, providers, references, scenes, sceneById } from "./fixtures";

export function PreviewApp() {
  const [sceneId, setSceneId] = useState<PreviewSceneId>("P01");
  const [navOverride, setNavOverride] = useState<NavId | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const scene = useMemo(() => sceneById(sceneId), [sceneId]);
  const activeNav = navOverride ?? scene.nav;

  useEffect(() => {
    setNavOverride(null);
    setEvidenceOpen(Boolean(scene.evidenceOpen));
  }, [sceneId, scene.evidenceOpen]);

  const layoutClass = [
    "preview-layout",
    scene.narrow ? "is-narrow" : "",
    scene.reducedMotion ? "is-reduced" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={layoutClass}>
      <div className="preview-banner">
        <div>
          <strong>UI Preview</strong>
          <span> · mock data · not live · 对照 docs/界面验收.md</span>
          <div className="caption-muted" style={{ marginTop: 4 }}>
            {scene.id} · {scene.description}
          </div>
        </div>
        <div className="scene-switcher" role="tablist" aria-label="预览场景">
          {scenes.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scene-chip${s.id === sceneId ? " is-active" : ""}`}
              onClick={() => setSceneId(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <AppShell
        badge="PREVIEW"
        activeNav={activeNav}
        onNav={(id) => setNavOverride(id)}
        hideSidebar={scene.narrow}
        topRight={<span>Preview Lab · 127.0.0.1:5173</span>}
      >
        {activeNav === "providers" ? (
          <ProvidersPage items={providers} />
        ) : activeNav === "references" ? (
          <ReferencesPage items={references} />
        ) : activeNav === "history" ? (
          <HistoryPage items={history} />
        ) : scene.phase === "setup" && scene.setup ? (
          <SetupPanel data={scene.setup} readOnly />
        ) : scene.phase === "running" && scene.running ? (
          <RunningPanel data={scene.running} />
        ) : scene.phase === "result" && scene.result ? (
          <ResultPanel
            data={scene.result}
            evidenceOpen={evidenceOpen}
            onToggleEvidence={() => setEvidenceOpen((v) => !v)}
          />
        ) : (
          <SetupPanel data={scenes[0].setup!} readOnly />
        )}
      </AppShell>
    </div>
  );
}
