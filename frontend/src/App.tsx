import React, { useState, useEffect, useCallback, useRef } from "react";
import { getSocket } from "./socket";
import type {
  AppMode, ModeChangePayload, RobotState, CameraState,
  LoggerState, EventLog, SaveStep, SaveProgressPayload,
} from "./types";
import TopBar from "./components/TopBar";
import WorkflowNav from "./components/WorkflowNav";
import StatusPanel from "./components/StatusPanel";
import CapturePage from "./pages/CapturePage";
import ReviewPage from "./pages/ReviewPage";
import DatasetPage from "./pages/DatasetPage";
import DiagnosticsPage from "./pages/DiagnosticsPage";
import SetupPage from "./pages/SetupPage";

export type Page = "capture" | "review" | "dataset" | "diagnostics" | "setup";

export default function App() {
  const [mode, setMode] = useState<AppMode>("IDLE");
  const [nextAction, setNextAction] = useState("");
  const [availableActions, setAvailableActions] = useState<string[]>([]);
  const [robot, setRobot] = useState<RobotState>({ connected: false });
  const [camera, setCamera] = useState<CameraState>({ available: false });
  const [logger, setLogger] = useState<LoggerState>({});
  const [events, setEvents] = useState<EventLog[]>([]);
  const [page, setPage] = useState<Page>("capture");
  const [devMode, setDevMode] = useState(false);

  const SAVE_STEP_LABELS: Record<string, string> = {
    stop_cameras:  "카메라 녹화 중단",
    flush_csv:     "CSV 저장",
    align_frames:  "프레임 정렬",
    video_color:   "컬러 비디오 인코딩",
    video_depth:   "뎁스 비디오 인코딩",
    video_webcam_0: "웹캠 0 비디오 인코딩",
    video_webcam_1: "웹캠 1 비디오 인코딩",
  };

  const initSaveSteps = (): SaveStep[] =>
    Object.entries(SAVE_STEP_LABELS).map(([key, label]) => ({
      key, label, status: "waiting", detail: "",
    }));

  const [saveSteps, setSaveSteps] = useState<SaveStep[]>(initSaveSteps());

  const socketRef = useRef(getSocket());

  useEffect(() => {
    const s = socketRef.current;

    s.on("mode_change", (data: ModeChangePayload) => {
      setMode(prev => {
        // SAVED/DISCARDED → RETURN_HOME → TEACH_READY 흐름 감지: capture 페이지로 이동
        if (data.mode === "TEACH_READY" && (prev === "SAVED" || prev === "DISCARDED" || prev === "RETURN_HOME")) {
          setPage("capture");
        }
        return data.mode;
      });
      setNextAction(data.next_action);
      setAvailableActions(data.available_actions);
      // PROCESSING 진입 시 review 페이지로 전환 + 스텝 초기화
      if (data.mode === "PROCESSING") {
        setPage("review");
        setSaveSteps(initSaveSteps());
      }
      if (data.mode === "REVIEW" || data.mode === "SAVED" || data.mode === "DISCARDED") {
        setPage("review");
      }
    });

    s.on("save_progress", (data: SaveProgressPayload) => {
      setSaveSteps(prev => prev.map(s =>
        s.key === data.step
          ? { ...s, status: data.status, detail: data.detail ?? "" }
          : s
      ));
    });

    s.on("robot_state", (data: RobotState) => setRobot(data));
    s.on("camera_state", (data: CameraState) => setCamera(data));
    s.on("logger_state", (data: LoggerState) => setLogger(data));
    s.on("event_log", (entry: EventLog) => {
      setEvents(prev => [...prev.slice(-99), entry]);
    });

    return () => {
      s.off("mode_change");
      s.off("save_progress");
      s.off("robot_state");
      s.off("camera_state");
      s.off("logger_state");
      s.off("event_log");
    };
  }, []);

  const handleGoBack = useCallback(() => {
    fetch("/api/go_back", { method: "POST" })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setPage("capture");
      });
  }, []);

  const renderMain = () => {
    if (page === "review") {
      return (
        <ReviewPage
          mode={mode}
          availableActions={availableActions}
          episodeId={logger.episode_id}
          saveSteps={saveSteps}
        />
      );
    }
    if (page === "dataset") return <DatasetPage />;
    if (page === "diagnostics") return <DiagnosticsPage devMode={devMode} robot={robot} camera={camera} />;
    if (page === "setup") return <SetupPage robot={robot} />;
    return (
      <CapturePage
        mode={mode}
        availableActions={availableActions}
        robot={robot}
        camera={camera}
        events={events}
      />
    );
  };

  return (
    <div style={styles.root}>
      <TopBar
        mode={mode}
        robot={robot}
        camera={camera}
        logger={logger}
        devMode={devMode}
        onToggleDev={() => setDevMode(v => !v)}
      />
      <div style={styles.body}>
        <WorkflowNav
          mode={mode}
          page={page}
          onNavigate={setPage}
          onGoBack={handleGoBack}
        />
        <main style={styles.main}>
          {renderMain()}
        </main>
        <StatusPanel
          mode={mode}
          robot={robot}
          camera={camera}
          logger={logger}
          events={events}
          availableActions={availableActions}
          nextAction={nextAction}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    overflow: "hidden",
    background: "#f0f2f5",
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  main: {
    flex: 1,
    overflow: "auto",
    padding: "16px",
  },
};
