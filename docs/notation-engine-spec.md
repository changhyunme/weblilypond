# WebLily 자체 노테이션 엔진 전환 스펙

상태: 구현 기준안  
대상: 웹 편집기 MVP  
최종 출력 기준: LilyPond SVG/PDF

## 1. 문제 정의

현재 `LilyEditor.tsx`는 LilyPond 소스를 상태의 원본으로 두고, 원격 컴파일된 SVG의 `textedit:` 링크를 소스 위치에 연결한다. 음표 드래그 중에는 최종 SVG 주변 노드를 복제·이동하고, 90ms 후 다시 컴파일한다. 이 방식은 다음 문제를 가진다.

- 포인터 이동이 소스 토큰과 컴파일 결과 DOM 구조에 종속된다.
- 음표 하나를 바꿀 때도 네트워크 및 전체 LilyPond 조판 지연이 발생한다.
- 복제한 SVG 조각은 beam, stem, accidental, spacing의 의미를 알지 못한다.
- 소스 위치 기반 선택은 소스가 바뀌면 깨지고 안정적인 undo/redo 식별자가 없다.
- 드래그 중 60fps와 컴파일 결과의 자연스러운 교체를 보장할 수 없다.

목표는 **Score AST를 편집 상태의 유일한 원본으로 삼고, 자체 Live SVG가 입력 프레임 안에 반응하며, LilyPond는 최종 SVG/PDF 조판기로만 사용하는 것**이다.

```text
pointer / keyboard
        |
        v
commands -> Score AST -> live layout -> Live SVG       (< 16.7ms interaction)
                    |
                    +-> LilyPond serializer -> compiler -> final SVG / PDF
                              ^                         |
                              +----- source map --------+
```

### 비목표

- MVP에서 LilyPond 전체 문법을 파싱하거나 시각적으로 편집하지 않는다.
- MVP Live SVG가 LilyPond와 모든 페이지에서 픽셀 단위로 동일하다고 주장하지 않는다.
- 자체 PDF, MIDI, 폰트 shaping 또는 범용 조판 엔진을 만들지 않는다.
- 드래그 도중 LilyPond를 호출하지 않는다.
- 임의의 고급 LilyPond 소스를 AST로 강제 변환하거나 재저장하며 손실시키지 않는다.
- 협업 편집, 모바일 제스처 완성, 플러그인 API는 MVP 범위가 아니다.

## 2. 제품 원칙과 상태 권한

1. `ScoreDocument.score`가 시각 편집 가능한 문서의 source of truth다.
2. Live SVG는 AST의 파생 결과이며 직접 수정하지 않는다.
3. LilyPond 소스도 AST의 파생 결과다. 지원 subset의 소스 편집은 parse 성공 후 AST transaction으로 반영한다.
4. 최종 SVG/PDF는 출판 결과의 기준이지만 편집 상태의 원본은 아니다.
5. 모든 음표, 마디, voice, staff는 저장 후에도 유지되는 안정적인 ID를 가진다.
6. 선택·undo·컴파일 source map은 문자열 offset이 아니라 안정적인 ID를 기준으로 한다.

문서 권한 모드는 명시적으로 나눈다.

```ts
type DocumentAuthority =
  | { kind: "score"; score: Score; sourceRevision: number }
  | { kind: "raw-lilypond"; source: string; lastGoodFinal?: FinalArtifact };
```

`score` 모드에서는 AST가 원본이다. `raw-lilypond` 모드에서는 문자열이 원본이며 Live SVG 편집은 비활성화한다. 두 권한을 동시에 허용하지 않는다.

## 3. Score AST v1

AST는 JSON 직렬화 가능하고 DOM, React, LilyPond 문법 타입을 참조하지 않는다. `id`는 UUID v7 또는 동일한 충돌 특성의 로컬 ID를 사용한다. pitch는 sounding pitch가 아니라 written pitch다.

```ts
type NodeId = string;
type Rational = Readonly<{ n: number; d: number }>; // 항상 약분, d > 0
type Step = "c" | "d" | "e" | "f" | "g" | "a" | "b";
type Accidental = "double-flat" | "flat" | "natural" | "sharp" | "double-sharp";
type DurationBase = 1 | 2 | 4 | 8 | 16;

interface Score {
  schemaVersion: 1;
  id: NodeId;
  revision: number;
  metadata: { title: string; subtitle?: string; composer?: string };
  settings: { pageSize: "a4"; concertPitch: boolean };
  staves: Staff[];
}

interface Staff {
  id: NodeId;
  name: string;
  shortName?: string;
  instrument?: "flute" | "violin" | "viola" | "cello" | "piano" | "generic";
  defaultClef: "treble" | "bass";
  voices: Voice[];
}

interface Voice {
  id: NodeId;
  measures: Measure[];
}

interface Measure {
  id: NodeId;
  number: number;
  time: { beats: number; beatUnit: 2 | 4 | 8 };
  key: { tonic: Step; accidental: "flat" | "natural" | "sharp"; mode: "major" | "minor" };
  events: ScoreEvent[];
}

type ScoreEvent = NoteEvent | RestEvent | ClefEvent | DynamicEvent | BarEvent;

interface EventBase {
  id: NodeId;
  onset: Rational; // 마디 시작 기준 whole-note 단위
  duration: Rational;
}

interface NoteEvent extends EventBase {
  kind: "note";
  pitch: { step: Step; octave: number; accidental?: Accidental }; // C4 = middle C
  notation: { dots: 0 | 1; tieStart?: boolean; tieStop?: boolean };
}

interface RestEvent extends EventBase {
  kind: "rest";
  notation: { dots: 0 | 1 };
}

interface ClefEvent extends EventBase { kind: "clef"; clef: "treble" | "bass" }
interface DynamicEvent extends EventBase { kind: "dynamic"; value: "pp" | "p" | "mp" | "mf" | "f" | "ff" }
interface BarEvent extends EventBase { kind: "bar"; style: "single" | "final" | "repeat-start" | "repeat-end" }
```

불변 조건은 reducer와 worker 양쪽에서 검사한다.

- 한 voice의 이벤트는 `(onset, id)` 오름차순이다.
- note/rest의 `duration.n > 0`; onset은 0 이상이다.
- MVP에서 이벤트 종료 시점은 마디 길이를 넘지 않는다.
- ID는 문서 내에서 유일하고 command 적용 중 변경되지 않는다.
- `revision`은 성공한 transaction마다 정확히 1 증가한다.
- duration 표기는 `duration`과 `notation.dots`에서 결정되며 중복 필드를 두지 않는다.

향후 chord, tuplet, multi-voice를 추가할 때 기존 node 의미를 바꾸지 않고 새 event/container 타입을 추가한다.

## 4. 공개 TypeScript 계약

모듈 경계는 다음 계약을 기준으로 구현한다.

```ts
// notation/model.ts
export function createScore(input?: Partial<Score>): Score;
export function validateScore(score: Score): ValidationIssue[];
export function getNode(score: Score, id: NodeId): ScoreEvent | Measure | Voice | Staff | undefined;

// notation/commands.ts
export type ScoreCommand =
  | { type: "note.movePitch"; noteId: NodeId; from: NoteEvent["pitch"]; to: NoteEvent["pitch"] }
  | { type: "event.setDuration"; eventId: NodeId; from: Rational; to: Rational; fromDots: 0 | 1; toDots: 0 | 1 }
  | { type: "note.setAccidental"; noteId: NodeId; from?: Accidental; to?: Accidental }
  | { type: "event.replace"; eventId: NodeId; from: NoteEvent | RestEvent; to: NoteEvent | RestEvent }
  | { type: "event.insert"; voiceId: NodeId; event: ScoreEvent }
  | { type: "event.delete"; voiceId: NodeId; event: ScoreEvent }
  | { type: "transaction"; label: string; commands: ScoreCommand[] };

export interface CommandResult { score: Score; changedIds: NodeId[] }
export function applyCommand(score: Score, command: ScoreCommand): CommandResult;
export function invertCommand(command: ScoreCommand): ScoreCommand;

// notation/history.ts
export interface HistoryState { past: ScoreCommand[]; future: ScoreCommand[] }
export function commit(history: HistoryState, command: ScoreCommand): HistoryState;
export function undo(score: Score, history: HistoryState): { score: Score; history: HistoryState };
export function redo(score: Score, history: HistoryState): { score: Score; history: HistoryState };

// notation/layout/types.ts
export type Sp = number; // 1sp = 인접 staff line 사이 거리
export interface ViewportSpec { widthSp: Sp; pageGapSp: Sp; scale: number }
export interface GlyphPlacement {
  nodeId: NodeId;
  role: "notehead" | "stem" | "flag" | "rest" | "accidental" | "dot" | "clef" | "bar" | "staff-line";
  glyph?: string;
  x: Sp;
  y: Sp;
  transform?: string;
  path?: string;
  bbox: { x: Sp; y: Sp; width: Sp; height: Sp };
  z: number;
}
export interface LayoutSnapshot {
  scoreRevision: number;
  layoutRevision: number;
  pages: Array<{ id: string; width: Sp; height: Sp; glyphs: GlyphPlacement[] }>;
  hitRegions: Array<{ nodeId: NodeId; pageId: string; x: Sp; y: Sp; width: Sp; height: Sp }>;
  anchors: Record<NodeId, { pageId: string; x: Sp; y: Sp }>;
}

// notation/layout/engine.ts
export function layoutScore(score: Score, viewport: ViewportSpec): LayoutSnapshot;
export function patchPitchDrag(
  layout: LayoutSnapshot,
  noteId: NodeId,
  diatonicSteps: number,
): Readonly<{ glyphUpdates: Array<Pick<GlyphPlacement, "nodeId" | "role" | "y" | "path" | "transform">> }>;

// notation/render/live-svg.ts
export interface LiveSvgRenderer {
  mount(host: HTMLElement): void;
  render(snapshot: LayoutSnapshot): void;
  patch(updates: ReturnType<typeof patchPitchDrag>): void;
  setSelection(selection: SelectionState): void;
  unmount(): void;
}

// notation/serialize/lilypond.ts
export interface SourceSpan { start: number; end: number; line: number; column: number }
export interface SerializedLilyPond {
  source: string;
  nodeSpans: Record<NodeId, SourceSpan>;
  revision: number;
}
export function serializeLilyPond(score: Score): SerializedLilyPond;

// notation/parse/lilypond-subset.ts
export type ParseResult =
  | { ok: true; score: Score; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[]; unsupported: SourceSpan[] };
export function parseLilyPondSubset(source: string): ParseResult;

// notation/reconcile.ts
export interface FinalArtifact {
  scoreRevision: number;
  pages: string[];
  nodeElements: Record<NodeId, { page: number; selector: string }>;
  generatedAt: number;
}
export function mapFinalSvg(
  pages: string[],
  source: SerializedLilyPond,
): FinalArtifact;
export function compareLayouts(live: LayoutSnapshot, final: FinalArtifact): ReconciliationReport;
```

UI store가 노출할 최소 계약은 아래와 같다.

```ts
interface EditorState {
  authority: DocumentAuthority;
  history: HistoryState;
  selection: SelectionState;
  liveLayout?: LayoutSnapshot;
  finalArtifact?: FinalArtifact;
  compile: { state: "idle" | "queued" | "running" | "success" | "error"; requestedRevision?: number };
}

type SelectionState =
  | { kind: "none" }
  | { kind: "event"; ids: NodeId[]; primaryId: NodeId };
```

## 5. Live SVG 좌표·레이아웃·글리프 규칙

### 좌표계

- 내부 단위는 `sp`이며 staff line 간격을 `1sp`로 둔다.
- SVG `viewBox`에서는 `1sp = 10 units`; CSS zoom은 viewBox를 바꾸지 않고 바깥 transform/width만 바꾼다.
- 각 staff의 가운데 선을 `y = 0`; 위쪽 음은 음수 y다.
- diatonic 한 단계(선→칸 또는 칸→선)는 `0.5sp`다.
- hit test는 화면 좌표를 `DOMPoint`와 `getScreenCTM().inverse()`로 SVG 좌표로 변환한 뒤 수행한다.
- 좌표는 layout 계산 중 1/64sp까지 유지하고 SVG 출력에서 최대 소수 셋째 자리로 반올림한다.

### MVP 레이아웃

- 페이지 여백, staff 길이, system 간격은 상수 token으로 시작한다. 매직 넘버를 component에 두지 않는다.
- 마디 폭은 `고정 최소 폭 + 박자 비례 spring + accidental/rest 여유`로 계산한다.
- 같은 onset은 같은 x-column을 사용한다. 단일 voice MVP에서는 onset 비례 배치 후 최소 간격 충돌을 순방향으로 해소한다.
- notehead y는 clef와 written pitch의 diatonic distance로 결정한다.
- stem 방향은 staff 중앙선 기준 기본 규칙을 사용하고, ledger line은 notehead 양쪽으로 `0.35sp` 연장한다.
- accidental은 notehead 왼쪽 `0.8sp`, dot은 오른쪽 `0.75sp`를 기준으로 bbox 충돌을 피한다.
- 전체 재레이아웃은 worker가 담당한다. 드래그 프레임에서는 선택 음표의 notehead/stem/flag/accidental/dot/ledger만 patch한다. 다른 음표의 x spacing은 pointerup까지 바꾸지 않는다.

### 글리프

- notehead, rest, flag, clef, accidental은 SMuFL 이름을 기준으로 관리한다.
- Live SVG는 런타임 폰트 fallback에 의존하지 않고 versioned SVG path table 또는 번들 WOFF2 한 종류를 사용한다.
- 최종 LilyPond와의 형태 차이를 줄이기 위한 1순위는 LilyPond가 사용하는 Emmentaler 계열 glyph/metric 자산이다. 배포 전 해당 자산의 라이선스와 웹 재배포 조건을 기록한다. 불가하면 SMuFL 글리프를 사용하고 최종 조판과의 허용 오차를 명시한다.
- glyph registry는 `glyphName -> path, advance, bbox, anchor`의 순수 데이터이며 renderer에서 음악 의미를 추론하지 않는다.
- 테스트 fixture는 glyph registry version을 고정한다.

## 6. 선택과 포인터 드래그

- 모든 표시 가능한 event의 SVG root group에 `data-node-id`와 `data-role`을 둔다.
- hit region은 보이는 bbox보다 최소 `0.8sp` 확장하고, 겹치면 포인터와 중심 거리, z-order, 이전 selection 순으로 결정한다.
- pointerdown 시 선택하고 pointer capture를 건다. 이동이 CSS pixel 3px 이하이면 click이다.
- pitch drag는 최초 note pitch를 기준으로 계산하며 누적 delta를 다시 누적하지 않는다.
- 기본 snap은 diatonic staff step `0.5sp`; `steps = round(-deltaYSp / 0.5)`이다.
- 드래그 범위는 MVP에서 원래 pitch 기준 ±14 diatonic steps다.
- 조표에 맞는 accidental은 pitch step 변경 후 policy가 결정한다. 기존 명시 accidental은 같은 음표에서 유지하되 새 조표와 모순되면 inspector에 명시 상태로 보인다.
- `Shift`는 pointer 움직임을 0.5배 감속하되 snap 단위는 유지한다. 수직 편집 중 x 이동은 무시한다.
- pointermove마다 AST를 commit하지 않는다. `DragSession.previewPitch`와 renderer patch만 갱신한다.
- pointerup에서 처음과 마지막 pitch가 다르면 `note.movePitch` 하나만 commit한다. 취소, Escape, pointercancel은 patch를 되돌리고 history를 만들지 않는다.
- 드래그 중 새 worker layout이나 최종 SVG가 도착해도 화면 교체를 보류한다.

```ts
interface DragSession {
  pointerId: number;
  noteId: NodeId;
  basePitch: NoteEvent["pitch"];
  previewPitch: NoteEvent["pitch"];
  startClientY: number;
  startedAt: number;
}
```

키보드 화살표와 inspector 변경도 동일한 command를 사용한다. UI별 별도 mutation 경로를 만들지 않는다.

## 7. Command model과 undo/redo

- 모든 영속 편집은 `ScoreCommand`로만 수행한다.
- command는 실행에 필요한 `from`과 `to` 값을 모두 가져 역연산이 deterministic해야 한다.
- reducer는 command 적용 전 target ID와 `from` 값이 현재 상태와 일치하는지 검사한다. 불일치하면 적용하지 않고 진단을 반환한다.
- 한 번의 drag는 pointermove 횟수와 관계없이 history 항목 하나다.
- duration+dot 같이 한 UI 동작에서 함께 바뀌는 값은 `transaction` 하나다.
- 연속 키보드 pitch 이동은 같은 note, 같은 command type, 400ms 이내일 때 하나로 coalesce할 수 있다.
- 새 command를 commit하면 redo stack은 비운다.
- source subset parse가 성공해 AST가 바뀌는 경우 structural diff를 command transaction으로 만들 수 있을 때만 기존 history에 넣는다. MVP에서는 안전하게 `source.replaceScore` checkpoint 하나로 기록해도 된다.
- 브라우저 `document.execCommand("undo")`를 사용하지 않는다. 악보/소스/inspector 모두 동일 history를 사용한다.

저장은 `Score`, schema version, history 제외 현재 revision, raw 모드 source를 저장한다. history 영속화는 MVP 비목표다.

## 8. Worker 경계

메인 스레드에 남길 작업:

- pointer capture, 좌표 변환, drag snap 계산
- 선택 상태와 transient drag session
- `patchPitchDrag`에 필요한 작은 y/path update 계산 또는 미리 계산된 pitch glyph 선택
- SVG DOM keyed patch 적용
- command commit과 즉시 최소 로컬 model update

Notation worker로 보낼 작업:

- LilyPond subset parse 및 diagnostics
- Score 전체 validation
- measure/system/page layout
- LilyPond serialization 및 node source map
- 저장용 structural diff

```ts
type WorkerRequest =
  | { type: "layout"; requestId: string; score: Score; viewport: ViewportSpec }
  | { type: "serialize"; requestId: string; score: Score }
  | { type: "parse"; requestId: string; source: string; previous?: Score };

type WorkerResponse =
  | { type: "layout.result"; requestId: string; scoreRevision: number; layout: LayoutSnapshot }
  | { type: "serialize.result"; requestId: string; scoreRevision: number; result: SerializedLilyPond }
  | { type: "parse.result"; requestId: string; result: ParseResult }
  | { type: "error"; requestId: string; message: string };
```

- 응답의 `scoreRevision`이 현재 revision보다 오래되면 폐기한다.
- worker가 죽으면 한 번 재시작하고 최신 Score snapshot으로 복구한다.
- worker 왕복은 드래그 프레임의 필수 경로가 아니다.
- 원격 LilyPond 컴파일은 worker가 직접 네트워크 호출하지 않고 별도 compile service/client가 담당한다.

## 9. LilyPond 직렬화와 최종 결과 reconciliation

serializer는 canonical source를 생성한다.

- 고정 LilyPond version, header, global key/time, staff/voice 순서와 whitespace를 사용한다.
- AST node마다 `nodeSpans`를 생성한다.
- 컴파일 요청은 `{ scoreRevision, source, nodeSpans }` snapshot이다.
- 새 revision이 생기면 진행 중 요청을 취소할 수 있으면 취소하고, 아니면 응답을 stale로 폐기한다.
- pointerup 이후 250ms idle 또는 명시적 컴파일에서 SVG를 요청한다. PDF는 사용자 요청 시에만 만든다.

최종 SVG의 `textedit:` line/column을 `nodeSpans`에 역매핑해 `nodeElements`를 만든다. source 위치가 한 node span 안에 들어올 때만 연결하며, 불명확하면 그 element는 선택 대상으로 사용하지 않는다.

화면 전환 정책:

1. Live SVG는 편집 화면의 기본이자 항상 유지되는 layer다.
2. 최종 SVG는 동일 revision에서 성공한 경우에만 수용한다.
3. drag/selection inspector 조작 중에는 최종 layer 전환을 보류한다.
4. final 모드(인쇄 미리보기) 또는 500ms 비활성 상태에서 최종 SVG를 표시할 수 있다.
5. Live와 final의 대응 node anchor 차이를 측정한다. 중앙값 `<= 0.35sp`, 95백분위 `<= 0.75sp`이면 120ms crossfade한다.
6. 오차가 기준을 넘거나 페이지/system break가 다르면 crossfade하지 않고 “최종 조판” 배지를 표시하며 즉시 교체하거나 사용자가 Live/Final을 비교하도록 한다.
7. final에서 선택된 node는 `nodeElements`로 highlight한다. 매핑되지 않으면 Live layer를 유지한다.
8. final 컴파일 실패 시 Live SVG와 편집 상태는 그대로 유지하고 오류만 표시한다.

따라서 “같은 형태”의 제품 정의는 다음과 같다.

- 같은 음표, pitch, duration, accidental, rest, clef, bar, staff/measure 순서를 표현한다.
- 같은 계열 glyph와 staff-space 기반 비례를 사용한다.
- 편집 중 시각 점프는 위 허용 오차 내에서 제한한다.
- 출판·다운로드의 픽셀 정확한 결과는 항상 LilyPond SVG/PDF다.

## 10. Source view round-trip 정책

### 지원 subset (`score` 권한)

MVP parser/serializer는 다음만 지원한다.

- `\version`, 단순 `\header`
- `\relative` 없이 absolute pitch로 생성하는 canonical source
- `\key`, `\time`, treble/bass `\clef`
- 단일 voice staff, 여러 staff의 동시 score
- note/rest, 1/2/4/8/16 duration, single dot
- bar/final bar, tie, 기본 dynamic
- instrument name/short name

source textarea 편집은 300ms debounce로 worker parse한다. 성공하면 AST를 교체하고 Live SVG를 갱신한다. parse 전 텍스트는 draft이며 저장·PDF 대상으로 승격하지 않는다. 오류가 있으면 마지막 정상 AST/Live SVG를 유지하고 span diagnostics를 표시한다.

serializer가 만든 source를 다시 parse했을 때 다음 의미가 같아야 한다.

```ts
semanticEqual(parseLilyPondSubset(serializeLilyPond(score).source).score, score) === true
```

canonical 포맷에서는 주석/공백을 보존하지 않는다. UI에 이 사실을 명시한다.

### Advanced raw mode

- 가져온 source에 지원하지 않는 문법이 하나라도 있으면 자동 재작성하지 않는다.
- 사용자는 “고급 소스 모드로 열기” 또는 “지원 범위만 새 문서로 변환” 중 선택한다.
- raw 모드는 원문을 byte-for-byte 보존하고 LilyPond compile, SVG/PDF, source 편집을 허용한다.
- raw 모드 악보는 최종 SVG viewer이며 음표 선택/drag/inspector를 비활성화한다.
- raw에서 score 모드 전환은 parser가 전체 문서를 성공적으로 처리하고 semantic round-trip 검사를 통과할 때만 가능하다.
- MVP에서는 AST 안에 임의 `RawBlock`을 섞지 않는다. 부분 편집 가능처럼 보이면서 serializer가 코드를 잃는 상황을 피한다.

## 11. 성능 예산

측정 환경은 production build, Chrome 최신 stable, 4x CPU slowdown, 500 notes/4 staves fixture다.

| 경로 | p50 | p95 / 상한 |
|---|---:|---:|
| pointermove handler + snap | 1ms | 2ms |
| 선택 note glyph patch | 3ms | 6ms |
| 한 interaction frame 전체 | 8ms | 16.7ms |
| click selection highlight | 8ms | 16.7ms |
| command reduce | 2ms | 5ms |
| worker full layout 500 notes | 40ms | 100ms |
| SVG 전체 keyed reconcile 500 notes | 20ms | 50ms |
| subset parse 2,000 lines | 60ms | 150ms |
| LilyPond serialize 500 notes | 20ms | 50ms |

- 드래그 5초 동안 long task(50ms 초과)는 0개여야 한다.
- 드래그 pointermove 처리 frame의 95% 이상이 16.7ms 안에 끝나야 한다.
- Live SVG 최초 유의미 표시 목표는 로컬 저장 문서 기준 300ms 이하다.
- 컴파일 latency는 Live 상호작용 SLA에 포함하지 않지만 상태가 UI를 막아서는 안 된다.
- performance marks: `notation:pointer`, `notation:patch`, `notation:layout`, `notation:svg-commit`, `notation:compile`을 남긴다.

## 12. MVP 범위

지원:

- score authority 생성/저장/열기
- treble/bass clef, key/time signature
- 1개 이상의 staff, staff별 단일 voice
- note/rest 입력·삭제·선택
- pitch drag, accidental 변경, octave 변경
- 1/2/4/8/16 및 single dot duration
- 기본 bar/final bar, tie, pp~ff dynamic
- zoom, 악보/소스/둘 다 보기
- command 기반 undo/redo
- canonical LilyPond source, 최종 SVG/PDF, 파트별 직렬화
- advanced raw mode 보존 및 최종 컴파일

미지원이며 UI에서 비활성/진단 처리:

- chord, polyphonic voices, cross-staff, grace note, tuplet
- beam 수동 편집, slur shape 편집, articulation/fingering/lyrics
- transposing instrument의 자동 written/concert 변환
- repeat alternatives, pickup/anacrusis, cadenza
- custom Scheme, include, layout/paper override, custom engraver
- arbitrary LilyPond variable/macro를 시각 편집 가능한 AST로 해석
- Live SVG의 정확한 page breaking과 collision parity 보장

## 13. 테스트와 완료 기준

### 단위/속성 테스트

- 모든 command에 대해 `apply(invert(command), apply(command, score))`가 원본과 semantic equal이다.
- 1,000개 seed 기반 유효 Score에서 serialize→parse가 semantic equal이다.
- Rational 정규화, clef별 pitch→staff position, drag delta→diatonic step 경계값을 검사한다.
- layout 결과의 모든 숫자는 finite이고, node ID가 hit region/anchor에 유지된다.
- stale worker/compile revision이 현재 state를 덮지 못한다.
- unsupported source는 raw 전환 진단을 반환하며 원문을 변경하지 않는다.

### 시각/통합 테스트

- 고정 fixture의 Live SVG screenshot을 glyph registry version별로 비교한다.
- C major 4/4, G major 3/4, treble/bass, dotted note/rest fixture에 대해 Live와 final anchor drift를 측정한다.
- pointerdown→14 step drag→pointerup에서 DOM y가 매 pointer frame 변화하고 command/history는 정확히 1개다.
- drag 중 느린 final SVG 응답이 와도 선택 glyph가 되돌아가지 않는다.
- undo/redo가 악보, source, final compile revision을 일관되게 갱신한다.
- compile 실패/offline에서도 Live 편집, 저장, undo가 동작한다.
- source parse 오류에서 마지막 정상 악보가 유지되고 PDF가 draft 오류 source로 실행되지 않는다.

### MVP 완료 acceptance criteria

1. 기본 악보 화면이 원격 컴파일 없이 저장된 AST에서 표시된다.
2. 음표를 위아래로 드래그할 때 실제 notehead와 관련 stem/flag/accidental/ledger가 포인터를 따라 프레임마다 이동한다.
3. 500-note fixture, 4x slowdown에서 드래그 frame 95%가 16.7ms 이내이고 50ms long task가 없다.
4. pointerup 한 번은 AST revision을 1 올리고 undo 항목 정확히 하나를 만든다.
5. undo 한 번으로 drag 전 pitch와 Live SVG 위치가 복구되고 redo로 다시 적용된다.
6. 네트워크를 끊어도 1~5가 동일하게 동작한다.
7. 지원 subset 문서는 source round-trip 후 의미 손실이 없다.
8. 미지원 문서는 raw 모드에서 원문이 보존되고 시각 편집 컨트롤이 활성화되지 않는다.
9. 최종 SVG는 동일 score revision만 표시하며 stale 응답은 폐기된다.
10. 정의된 fixture에서 Live/final node anchor drift가 중앙값 0.35sp, p95 0.75sp 이하이거나, 초과 시 무점프 전환 정책과 “최종 조판” 표시가 작동한다.
11. PDF와 파트보는 화면 DOM이 아니라 동일 revision의 serialized LilyPond에서 생성된다.
12. 타입 검사, lint, unit/property/integration/visual/performance test가 CI에서 통과한다.

## 14. 마이그레이션 단계

### 단계 0 — 기준선과 제거 경계

- 현재 drag/compile latency와 fixture SVG를 기록한다.
- 기존 `SelectedNote` source offset, `createOptimisticNotePreview`, SVG sibling 탐색을 legacy adapter로 격리한다.
- 새 기능을 `notationEngineV1` flag 뒤에 둔다.

완료: 기존 기능 회귀 없이 performance 측정이 CI/로컬에서 재현된다.

### 단계 1 — AST, command, history

- `notation/model`, validation, reducer, inverse command, history를 구현한다.
- starter score를 AST fixture로 옮기고 저장 schema migration을 추가한다.
- inspector와 keyboard를 command에 연결하되 기존 SVG 표시를 유지한다.

완료: pitch/duration/rest 편집과 undo/redo가 문자열 offset 없이 동작한다.

### 단계 2 — Live layout와 SVG

- glyph registry, staff/note/rest/bar layout, hit regions, keyed SVG renderer를 구현한다.
- 기본 score 화면을 Live SVG로 전환한다.
- main-thread drag patch와 pointerup command commit을 구현한다.

완료: acceptance criteria 1~6과 performance budget을 충족한다.

### 단계 3 — serializer, compile, reconciliation

- canonical serializer와 node source map을 구현한다.
- revision-tagged SVG/PDF compile 및 stale 폐기를 추가한다.
- final SVG node mapping, drift report, safe layer 전환을 구현한다.

완료: acceptance criteria 9~11과 drift fixture를 충족한다.

### 단계 4 — source round-trip와 raw mode

- subset parser worker, draft diagnostics, parse 성공 transaction을 구현한다.
- unsupported import의 raw 보존 모드와 전환 UI를 구현한다.

완료: acceptance criteria 7~8, 원문 무손실 fixture를 충족한다.

### 단계 5 — legacy 제거와 배포

- source offset 기반 selection, DOM clone optimistic preview, 자동 90ms compile 경로를 삭제한다.
- feature flag를 기본 활성화하고 이전 localStorage 문서를 안전하게 가져온다.
- 전체 CI/접근성/오프라인/대형 fixture 검증 후 legacy 코드를 제거한다.

완료: acceptance criteria 1~12가 production build에서 모두 증명된다.

## 15. 위험과 완화

| 위험 | 완화 |
|---|---|
| Live와 LilyPond spacing/page break가 달라 교체 시 점프 | Live를 편집 기본 layer로 유지하고 node drift를 계측한다. 기준 밖이면 crossfade하지 않고 final 모드를 명시한다. |
| LilyPond glyph 자산 라이선스/웹 폰트 제약 | 구현 전 라이선스 검토를 gate로 두고, 불가하면 versioned SMuFL 자산과 drift 기준을 사용한다. |
| LilyPond 문법 범위가 무제한으로 커짐 | score subset과 raw authority를 분리하고 unsupported 문법을 절대 묵시적으로 재작성하지 않는다. |
| worker serialization 비용과 큰 structured clone | revision snapshot을 단순 JSON으로 유지하고, 단계 후 profiling으로 patch message/transferable 도입을 결정한다. |
| worker 결과가 drag 중 화면을 되돌림 | revision 검사와 interaction lock으로 layout/final 적용을 보류한다. |
| ID가 source round-trip에서 소실 | 이전 AST와 source span 기반 deterministic matching을 사용하되 불명확하면 새 ID를 부여하고 selection을 해제한다. serializer 내부 source map은 기존 ID를 그대로 유지한다. |
| 다중 staff에서 layout 복잡도 급증 | MVP는 staff별 단일 voice와 제한된 collision 규칙으로 고정하고 unsupported 타입을 validation에서 차단한다. |
| React 전체 rerender가 16ms 예산을 침해 | drag transient state를 React state 밖 session/ref에 두고 SVG renderer에 keyed imperative patch를 적용한다. pointerup에서만 store commit한다. |
| 최종 컴파일 서비스 장애 | Live 편집/저장/undo를 완전 로컬로 유지하고 SVG/PDF만 재시도 가능한 상태로 둔다. |
| 저장 schema 변경으로 기존 문서 손실 | versioned migration, 원본 LilyPond 백업, migration 실패 시 raw 모드 fallback을 제공한다. |

## 16. 구현 시작 순서

첫 구현 PR은 UI를 크게 바꾸지 말고 아래 수직 절단을 완성한다.

1. treble staff 한 개, 8개 quarter note의 AST fixture.
2. notehead/staff/stem만 그리는 Live SVG와 stable `data-node-id`.
3. 포인터 drag transient patch, pointerup `note.movePitch` command.
4. command undo/redo.
5. production performance test와 프레임 계측.
6. 같은 AST의 LilyPond serialize 및 최종 SVG revision 폐기.

이 수직 절단이 acceptance criteria 1~6을 통과하기 전에는 chord, beam, source parser 범위를 넓히지 않는다.
