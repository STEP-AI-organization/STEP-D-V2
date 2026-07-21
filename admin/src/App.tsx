import { useState } from "react";
import MatchTab from "./tabs/MatchTab";
import DatasetTab from "./tabs/DatasetTab";
import VideosTab from "./tabs/VideosTab";

/**
 * STEP D Lab — 채널 학습 데이터를 만드는 도구.
 *
 * 2026-07-20: 파이프라인 결과 검수 탭(쇼츠 추천·타임라인·출연진·장면·자막)을 제거했다.
 * GCS에서 "가장 최신 분석 1건"만 읽는 구조라 미디어를 고를 수 없었고, 실사용이 매칭으로
 * 옮겨갔다. 필요하면 git 이력에서 되살릴 수 있고, 서버의 /api/lab/data·frames·portraits·
 * video 라우트는 그대로 남아 있다.
 */
type TabKey = "match" | "videos" | "dataset";

const TABS: { key: TabKey; label: string }[] = [
  { key: "match", label: "🔗 숏폼 매칭" },
  { key: "videos", label: "🎬 영상별 작업" },
  { key: "dataset", label: "📊 데이터셋 · 현황" },
];

export default function App() {
  const [tab, setTab] = useState<TabKey>("match");

  return (
    <>
      <header>
        <h1>STEP D Lab</h1>
        <span className="vid">채널 학습 데이터</span>
      </header>

      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={`tab${tab === t.key ? " on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </div>
        ))}
      </div>

      <main className="page">
        {tab === "match" ? <MatchTab /> : tab === "videos" ? <VideosTab /> : <DatasetTab />}
      </main>
    </>
  );
}
