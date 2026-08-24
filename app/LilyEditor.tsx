import DOMPurify from "dompurify";
import {
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Download,
  FileMusic,
  FilePlus2,
  FolderOpen,
  Gauge,
  ListMusic,
  LoaderCircle,
  Music2,
  PanelLeftClose,
  Play,
  Redo2,
  Save,
  Undo2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ScoreDocument = {
  id: string;
  name: string;
  instrument?: string;
  kind: "score" | "part";
  code: string;
};

type RpcResult = { files: string[]; logs: string; midi?: string };

const DEFAULT_SOURCE = String.raw`\version "2.26.0"

\header {
  title = "봄의 작은 왈츠"
  subtitle = "작은 앙상블을 위한 스케치"
  composer = "WebLily Studio"
  tagline = ##f
}

global = {
  \key g \major
  \time 3/4
  \tempo "Andante" 4 = 88
}

fluteMusic = \relative c'' {
  \global
  b4\p( d g) | fis2 e4 | d4( b g) | a2. |
  b4( c d) | e2 d4 | c4( a fis) | g2. \bar "|."
}

violinMusic = \relative c'' {
  \global
  g2\p a4 | b2 c4 | b2 g4 | fis2. |
  g4( a b) | c2 b4 | a2 fis4 | g2. \bar "|."
}

celloMusic = \relative c {
  \global
  \clef bass
  g2\p d4 | g2 c4 | g2 e4 | d2. |
  e2 b4 | c2 g4 | d'2 d,4 | g2. \bar "|."
}

\score {
  \new StaffGroup <<
    \new Staff \with { instrumentName = "Flute" shortInstrumentName = "Fl." } { \fluteMusic }
    \new Staff \with { instrumentName = "Violin" shortInstrumentName = "Vln." } { \violinMusic }
    \new Staff \with { instrumentName = "Cello" shortInstrumentName = "Vc." } { \celloMusic }
  >>
  \layout { }
  \midi { }
}`;

const STARTER_DOC: ScoreDocument = {
  id: "full-score",
  name: "봄의 작은 왈츠",
  kind: "score",
  code: DEFAULT_SOURCE,
};

const SNIPPETS = [
  { label: "음표", value: "c'4 ", title: "4분음표 삽입" },
  { label: "쉼표", value: "r4 ", title: "4분쉼표 삽입" },
  { label: "화음", value: "<c' e' g'>4 ", title: "화음 삽입" },
  { label: "붙임줄", value: "( )", title: "프레이즈 삽입" },
  { label: "셈여림", value: "\\mf ", title: "셈여림표 삽입" },
  { label: "반복", value: "\\repeat volta 2 {  }", title: "반복 구간 삽입" },
];

const INSTRUMENT_KO: Record<string, string> = {
  Flute: "플루트",
  Violin: "바이올린",
  Cello: "첼로",
  Viola: "비올라",
  Clarinet: "클라리넷",
  Piano: "피아노",
};

function makePartDocuments(source: string): ScoreDocument[] {
  const scoreIndex = source.lastIndexOf("\\score");
  if (scoreIndex < 0) return [];
  const preamble = source.slice(0, scoreIndex).trimEnd();
  const pattern = /\\new\s+Staff\s+\\with\s*\{([\s\S]*?)\}\s*\{\s*\\([A-Za-z][A-Za-z0-9]*)\s*\}/g;
  const parts: ScoreDocument[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const settings = match[1];
    const variable = match[2];
    const instrument = settings.match(/instrumentName\s*=\s*"([^"]+)"/)?.[1] ?? variable;
    parts.push({
      id: `part-${variable.toLowerCase()}`,
      name: `${INSTRUMENT_KO[instrument] ?? instrument} 파트보`,
      instrument,
      kind: "part",
      code: `${preamble}\n\n\\score {\n  \\new Staff \\with { instrumentName = "${instrument}" } { \\${variable} }\n  \\layout { }\n}`,
    });
  }
  return parts;
}

function downloadData(filename: string, href: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function safeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "score";
}

export function LilyEditor() {
  const [documents, setDocuments] = useState<ScoreDocument[]>([STARTER_DOC]);
  const [activeId, setActiveId] = useState(STARTER_DOC.id);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [compileState, setCompileState] = useState<"idle" | "compiling" | "success" | "error">("idle");
  const [pages, setPages] = useState<string[]>([]);
  const [logs, setLogs] = useState("");
  const [zoom, setZoom] = useState(82);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLPreElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, { resolve: (value: RpcResult) => void; reject: (reason: Error) => void; timer: number }>());
  const compileVersionRef = useRef(0);

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeId) ?? documents[0],
    [activeId, documents],
  );
  const parts = useMemo(() => documents.filter((document) => document.kind === "part"), [documents]);

  useEffect(() => {
    const saved = localStorage.getItem("weblily-project-v1");
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { documents?: ScoreDocument[]; activeId?: string };
      if (parsed.documents?.length) {
        setDocuments(parsed.documents);
        setActiveId(parsed.activeId ?? parsed.documents[0].id);
      }
    } catch {
      localStorage.removeItem("weblily-project-v1");
    }
  }, []);

  useEffect(() => {
    const socket = new WebSocket("wss://render.hacklily.org/rpc");
    socketRef.current = socket;
    socket.onopen = () => setConnection("online");
    socket.onclose = () => {
      setConnection("offline");
      pendingRef.current.forEach(({ reject, timer }) => {
        window.clearTimeout(timer);
        reject(new Error("렌더러 연결이 종료되었습니다."));
      });
      pendingRef.current.clear();
    };
    socket.onerror = () => setConnection("offline");
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { id?: string; result?: RpcResult; error?: { message?: string; data?: { logs?: string } } };
        if (!payload.id || payload.id.startsWith("ping-")) return;
        const pending = pendingRef.current.get(payload.id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingRef.current.delete(payload.id);
        if (payload.error) pending.reject(new Error(payload.error.data?.logs || payload.error.message || "컴파일에 실패했습니다."));
        else if (payload.result) pending.resolve(payload.result);
      } catch {
        setConnection("offline");
      }
    };

    const ping = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: `ping-${Date.now()}`, method: "ping", params: {} }));
    }, 15000);

    return () => {
      window.clearInterval(ping);
      socket.close();
      pendingRef.current.forEach(({ reject, timer }) => {
        window.clearTimeout(timer);
        reject(new Error("연결이 종료되었습니다."));
      });
      pendingRef.current.clear();
    };
  }, []);

  const rpcRender = useCallback((source: string, backend: "svg" | "pdf") => new Promise<RpcResult>((resolve, reject) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("렌더러에 연결되지 않았습니다."));
      return;
    }
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pendingRef.current.delete(id);
      reject(new Error("렌더링 시간이 초과되었습니다."));
    }, 20000);
    pendingRef.current.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "render", params: { backend, src: source, version: "stable" } }));
  }), []);

  const compile = useCallback(async () => {
    if (!activeDocument) return;
    const version = ++compileVersionRef.current;
    setCompileState("compiling");
    try {
      const result = await rpcRender(activeDocument.code, "svg");
      if (version !== compileVersionRef.current) return;
      if (!result.files?.length || !result.files[0].trim()) throw new Error(result.logs || "출력된 악보가 없습니다.");
      setPages(result.files.map((page) => DOMPurify.sanitize(page, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ["use"],
        ADD_ATTR: ["xlink:href", "href", "pointer-events"],
      })));
      setLogs(result.logs ?? "");
      setCompileState("success");
    } catch (error) {
      if (version !== compileVersionRef.current) return;
      setLogs(error instanceof Error ? error.message : "컴파일에 실패했습니다.");
      setCompileState("error");
    }
  }, [activeDocument, rpcRender]);

  useEffect(() => {
    if (!activeDocument || connection !== "online") return;
    const timer = window.setTimeout(compile, 850);
    return () => window.clearTimeout(timer);
  }, [activeDocument, compile, connection]);

  const saveProject = useCallback(() => {
    localStorage.setItem("weblily-project-v1", JSON.stringify({ documents, activeId }));
    setToast("이 브라우저에 저장했습니다");
    window.setTimeout(() => setToast(""), 1800);
  }, [activeId, documents]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveProject();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        compile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [compile, saveProject]);

  const updateCode = (code: string) => {
    setDocuments((current) => current.map((document) => document.id === activeId ? { ...document, code } : document));
  };

  const insertSnippet = (value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    updateCode(`${activeDocument.code.slice(0, start)}${value}${activeDocument.code.slice(end)}`);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const newProject = () => {
    if (!window.confirm("현재 작업 대신 새 악보를 시작할까요? 저장하지 않은 변경은 사라집니다.")) return;
    setDocuments([{ ...STARTER_DOC, code: String.raw`\version "2.26.0"

\header { title = "새 악보" tagline = ##f }

music = \relative c' {
  \key c \major
  \time 4/4
  c4 d e f | g1 \bar "|."
}

\score { \new Staff { \music } \layout { } }` }]);
    setActiveId(STARTER_DOC.id);
    setToast("새 악보를 만들었습니다");
    window.setTimeout(() => setToast(""), 1800);
  };

  const openSource = async (file: File) => {
    const code = await file.text();
    const name = file.name.replace(/\.ly$/i, "") || "가져온 악보";
    setDocuments([{ id: "full-score", name, kind: "score", code }]);
    setActiveId("full-score");
    setToast(`${file.name}을 열었습니다`);
    window.setTimeout(() => setToast(""), 1800);
  };

  const generateParts = () => {
    const fullScore = documents.find((document) => document.kind === "score");
    if (!fullScore) return;
    const generated = makePartDocuments(fullScore.code);
    if (!generated.length) setToast("파트를 찾지 못했습니다. instrumentName과 음악 변수를 확인하세요.");
    else {
      setDocuments([fullScore, ...generated]);
      setActiveId(generated[0].id);
      setToast(`${generated.length}개의 파트보를 만들었습니다`);
    }
    window.setTimeout(() => setToast(""), 2400);
  };

  const downloadPdf = async (document: ScoreDocument) => {
    setDownloadingId(document.id);
    try {
      const result = await rpcRender(document.code, "pdf");
      if (!result.files?.[0]) throw new Error("PDF 결과가 없습니다.");
      downloadData(`${safeFilename(document.name)}.pdf`, `data:application/pdf;base64,${result.files[0]}`);
      setToast(`${document.name} PDF를 만들었습니다`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "PDF 생성에 실패했습니다.");
    } finally {
      setDownloadingId(null);
      window.setTimeout(() => setToast(""), 2200);
    }
  };

  const downloadSource = () => downloadData(
    `${safeFilename(activeDocument.name)}.ly`,
    `data:text/plain;charset=utf-8,${encodeURIComponent(activeDocument.code)}`,
  );

  const lineNumbers = useMemo(
    () => Array.from({ length: activeDocument.code.split("\n").length }, (_, index) => index + 1).join("\n"),
    [activeDocument.code],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <button className="icon-button sidebar-toggle" aria-label="사이드바 열고 닫기" onClick={() => setSidebarOpen((value) => !value)}><PanelLeftClose size={18} /></button>
          <div className="brand-mark"><Music2 size={18} strokeWidth={2.3} /></div>
          <div className="brand-copy"><strong>WEBLILY</strong><span>Score studio</span></div>
        </div>
        <div className="document-title"><span>{activeDocument.name}</span><span className="saved-indicator"><Check size={12} /> 로컬 저장</span></div>
        <div className="top-actions">
          <span className={`connection ${connection}`}><i />{connection === "online" ? "렌더러 연결됨" : connection === "connecting" ? "연결 중" : "오프라인"}</span>
          <button className="subtle-button" onClick={saveProject}><Save size={15} />저장</button>
          <button className="primary-button" onClick={() => downloadPdf(activeDocument)} disabled={downloadingId !== null || connection !== "online"}>
            {downloadingId === activeDocument.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}PDF
          </button>
        </div>
      </header>

      <section className={`workspace ${sidebarOpen ? "with-sidebar" : "without-sidebar"}`}>
        {sidebarOpen && (
          <aside className="project-sidebar">
            <div className="side-heading"><span>프로젝트</span><button className="icon-button" aria-label="새 파일" onClick={newProject}><FilePlus2 size={16} /></button></div>
            <button className={`document-row ${activeId === "full-score" ? "active" : ""}`} onClick={() => setActiveId("full-score")}>
              <span className="file-icon score"><FileMusic size={16} /></span>
              <span><strong>전체 악보</strong><small>Full score · {documents[0].code.split("\n").length} lines</small></span>
            </button>
            <div className="parts-heading"><span>파트보 <b>{parts.length}</b></span></div>
            <div className="parts-list">
              {parts.length ? parts.map((part) => (
                <button className={`document-row ${activeId === part.id ? "active" : ""}`} key={part.id} onClick={() => setActiveId(part.id)}>
                  <span className="file-icon part"><ListMusic size={15} /></span>
                  <span><strong>{part.name}</strong><small>{part.instrument} · A4</small></span>
                  <span className="row-download" role="button" aria-label={`${part.name} PDF 다운로드`} title="PDF 다운로드" onClick={(event) => { event.stopPropagation(); downloadPdf(part); }}>
                    {downloadingId === part.id ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
                  </span>
                </button>
              )) : <p className="empty-parts">전체 악보에서 파트를 추출해<br />개별 파트보를 만드세요.</p>}
            </div>
            <button className="generate-button" onClick={generateParts}><WandSparkles size={15} />파트보 생성</button>
            <div className="side-spacer" />
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".ly,text/plain" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void openSource(file); event.currentTarget.value = ""; }} />
            <button className="side-link" onClick={() => fileInputRef.current?.click()}><FolderOpen size={15} />LilyPond 파일 열기</button>
            <a className="side-link" href="https://lilypond.org/doc/v2.26/Documentation/learning/" target="_blank" rel="noreferrer"><CircleHelp size={15} />LilyPond 문법 도움말</a>
          </aside>
        )}

        <section className="editor-pane">
          <div className="pane-header editor-header">
            <div className="pane-title"><Code2 size={15} /><strong>{activeDocument.kind === "score" ? "score.ly" : `${activeDocument.instrument?.toLowerCase() ?? "part"}.ly`}</strong><span>LilyPond</span></div>
            <div className="pane-actions">
              <button className="icon-button" aria-label="실행 취소" title="실행 취소" onClick={() => { textareaRef.current?.focus(); document.execCommand("undo"); }}><Undo2 size={15} /></button>
              <button className="icon-button" aria-label="다시 실행" title="다시 실행" onClick={() => { textareaRef.current?.focus(); document.execCommand("redo"); }}><Redo2 size={15} /></button>
              <button className="icon-button" aria-label="소스 다운로드" title=".ly 다운로드" onClick={downloadSource}><Download size={15} /></button>
            </div>
          </div>
          <div className="snippet-bar" aria-label="빠른 입력 도구">
            {SNIPPETS.map((snippet) => <button key={snippet.label} title={snippet.title} onClick={() => insertSnippet(snippet.value)}>{snippet.label}</button>)}
            <span className="snippet-separator" />
            <button title="블록 삽입" onClick={() => insertSnippet("\\relative c' {\n  \n}\n")}><Braces size={14} /></button>
          </div>
          <div className="code-editor">
            <pre ref={lineRef} className="line-numbers" aria-hidden="true">{lineNumbers}</pre>
            <textarea ref={textareaRef} value={activeDocument.code} onChange={(event) => updateCode(event.target.value)} onScroll={(event) => { if (lineRef.current) lineRef.current.scrollTop = event.currentTarget.scrollTop; }} spellCheck={false} aria-label="LilyPond 코드 편집기" wrap="off" />
          </div>
          <div className="editor-statusbar"><span>{activeDocument.code.split("\n").length} lines</span><span>UTF-8</span><span>Spaces: 2</span><span>LilyPond 2.26</span></div>
        </section>

        <section className="preview-pane">
          <div className="pane-header preview-header">
            <div className="pane-title"><FileMusic size={15} /><strong>악보 미리보기</strong><span>{pages.length || 1} page</span></div>
            <div className="preview-actions">
              <button className="icon-button" aria-label="축소" onClick={() => setZoom((value) => Math.max(50, value - 10))}><ZoomOut size={15} /></button>
              <span>{zoom}%</span>
              <button className="icon-button" aria-label="확대" onClick={() => setZoom((value) => Math.min(140, value + 10))}><ZoomIn size={15} /></button>
              <span className="action-divider" />
              <button className="compile-button" onClick={compile} disabled={connection !== "online" || compileState === "compiling"} title="⌘/Ctrl + Enter">
                {compileState === "compiling" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} fill="currentColor" />}컴파일
              </button>
            </div>
          </div>
          <div className="preview-canvas">
            {pages.length ? (
              <div className="score-pages" style={{ width: `${zoom}%` }}>
                {pages.map((page, index) => <article className="score-page" key={`${activeId}-${index}`} dangerouslySetInnerHTML={{ __html: page }} />)}
              </div>
            ) : (
              <div className="preview-placeholder">
                {compileState === "compiling" ? <><LoaderCircle className="spin" size={24} /><strong>악보를 조판하고 있습니다</strong><span>잠시만 기다려 주세요.</span></> :
                  compileState === "error" ? <><Braces size={24} /><strong>코드를 확인해 주세요</strong><span>아래 컴파일 로그에서 오류를 확인할 수 있습니다.</span></> :
                  <><Music2 size={26} /><strong>미리보기를 준비 중입니다</strong><span>렌더러 연결 후 자동으로 표시됩니다.</span></>}
              </div>
            )}
          </div>
          <div className={`compile-drawer ${compileState === "error" ? "has-error" : ""}`}>
            <div className="compile-summary">
              <span>{compileState === "success" ? <Check size={14} /> : compileState === "error" ? <Braces size={14} /> : <Gauge size={14} />}</span>
              <strong>{compileState === "success" ? "컴파일 완료" : compileState === "error" ? "컴파일 오류" : compileState === "compiling" ? "컴파일 중" : "준비됨"}</strong>
              <small>{compileState === "success" ? "최신 변경사항이 반영되었습니다" : compileState === "error" ? "로그에서 원인을 확인하세요" : "⌘ Enter로 바로 컴파일"}</small>
              <ChevronDown size={15} />
            </div>
            {compileState === "error" && <pre className="compile-logs">{logs}</pre>}
          </div>
        </section>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
