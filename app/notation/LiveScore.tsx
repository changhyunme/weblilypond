import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { NoteEvent, ScoreModel } from "./model";
import "./live-score.css";

export type LiveScoreProps = {
  score: ScoreModel;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  onChangePitch: (id: string, diatonicSteps: number) => void;
};

const PAGE_WIDTH = 1200;
const PAGE_TOP = 160;
const PAGE_BOTTOM = 72;
const LEFT_MARGIN = 154;
const RIGHT_MARGIN = 58;
const STAFF_GAP = 148;
const STAFF_SPACE = 10;
const DIATONIC_STEP = STAFF_SPACE / 2;
const PITCH_NAMES = ["c", "d", "e", "f", "g", "a", "b"] as const;

type DragSession = {
  pointerId: number;
  eventId: string;
  group: SVGGElement;
  label: SVGTextElement | null;
  baseX: number;
  baseY: number;
  startSvgY: number;
  latestDeltaY: number;
  snappedSteps: number;
};

function pitchNumber(note: NoteEvent) {
  return note.octave * 7 + PITCH_NAMES.indexOf(note.pitch);
}

function pitchY(note: NoteEvent, clef: "treble" | "bass") {
  // Treble staff centre is B4; bass staff centre is D3.
  const centrePitch = clef === "treble" ? 4 * 7 + 6 : 3 * 7 + 1;
  return -(pitchNumber(note) - centrePitch) * DIATONIC_STEP;
}

function eventAriaLabel(note: NoteEvent, staffName: string) {
  const accidental = note.accidental === "is"
    ? "sharp"
    : note.accidental === "isis"
      ? "double sharp"
      : note.accidental === "es"
        ? "flat"
        : note.accidental === "eses"
          ? "double flat"
          : "natural";
  return `${staffName}, ${note.pitch.toUpperCase()}${note.octave} ${accidental}, ${note.duration}분음표. 위아래 화살표로 음정을 변경합니다.`;
}

function accidentalGlyph(accidental: NoteEvent["accidental"]) {
  if (accidental === "is") return "♯";
  if (accidental === "isis") return "𝄪";
  if (accidental === "es") return "♭";
  if (accidental === "eses") return "𝄫";
  return null;
}

function ledgerOffsets(noteY: number) {
  const offsets: number[] = [];
  if (noteY <= -6 * DIATONIC_STEP) {
    for (let y = -6 * DIATONIC_STEP; y >= noteY - 0.1; y -= STAFF_SPACE) offsets.push(y);
  }
  if (noteY >= 6 * DIATONIC_STEP) {
    for (let y = 6 * DIATONIC_STEP; y <= noteY + 0.1; y += STAFF_SPACE) offsets.push(y);
  }
  return offsets;
}

function RestSymbol({ duration, dots }: { duration: string; dots: number }) {
  const glyph = duration === "4" ? "𝄽" : duration === "8" ? "𝄾" : duration === "16" ? "𝄿" : null;
  return (
    <g className="live-score__rest-symbol" aria-hidden="true">
      {duration === "1" && <rect x={-7} y={-5} width={14} height={5} rx={0.8} />}
      {duration === "2" && <rect x={-7} y={-10} width={14} height={5} rx={0.8} />}
      {glyph && <text x={0} y={6}>{glyph}</text>}
      {Array.from({ length: dots }, (_, index) => (
        <circle key={index} cx={11 + index * 6} cy={0} r={1.65} />
      ))}
    </g>
  );
}

function NoteSymbol({ note, noteY }: { note: NoteEvent; noteY: number }) {
  const hollow = note.duration === "1" || note.duration === "2";
  const stemDown = noteY < 2 * DIATONIC_STEP;
  const hasStem = note.duration !== "1";
  const flagCount = note.duration === "16" ? 2 : note.duration === "8" ? 1 : 0;
  const stemX = stemDown ? -6 : 6;
  const stemEnd = stemDown ? 35 : -35;
  const accidental = accidentalGlyph(note.accidental);

  return (
    <g className="live-score__note-symbol" aria-hidden="true">
      {ledgerOffsets(noteY).map((offset) => (
        <line key={offset} className="live-score__ledger" x1={-11} x2={11} y1={offset - noteY} y2={offset - noteY} />
      ))}
      {accidental && <text className="live-score__accidental" x={-16} y={5}>{accidental}</text>}
      <ellipse className={hollow ? "is-hollow" : undefined} cx={0} cy={0} rx={7.2} ry={5.1} transform="rotate(-17)" />
      {hasStem && <line className="live-score__stem" x1={stemX} x2={stemX} y1={0} y2={stemEnd} />}
      {Array.from({ length: flagCount }, (_, index) => {
        const y = stemDown ? stemEnd + index * 8 : stemEnd + index * 8;
        const direction = stemDown ? -1 : 1;
        return (
          <path
            key={index}
            className="live-score__flag"
            d={`M ${stemX} ${y} C ${stemX + 13 * direction} ${y + 6}, ${stemX + 13 * direction} ${y + 18}, ${stemX + 4 * direction} ${y + 24}`}
          />
        );
      })}
      {Array.from({ length: note.dots }, (_, index) => (
        <circle key={index} className="live-score__dot" cx={11 + index * 6} cy={-2.5} r={1.65} />
      ))}
    </g>
  );
}

export function LiveScore({ score, selectedEventId, onSelectEvent, onChangePitch }: LiveScoreProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const groupsRef = useRef(new Map<string, SVGGElement>());
  const labelsRef = useRef(new Map<string, SVGTextElement>());
  const dragRef = useRef<DragSession | null>(null);
  const frameRef = useRef<number | null>(null);

  const measureNumbers = useMemo(() => {
    const values = score.staves.flatMap((staff) => staff.events.map((event) => event.measure));
    const maximum = Math.max(1, ...values);
    return Array.from({ length: maximum }, (_, index) => index + 1);
  }, [score.staves]);

  const pageHeight = Math.max(430, PAGE_TOP + Math.max(1, score.staves.length) * STAFF_GAP + PAGE_BOTTOM);
  const notationWidth = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN;
  const measureWidth = notationWidth / measureNumbers.length;

  const clientToSvgY = (clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return clientY;
    const point = new DOMPoint(0, clientY).matrixTransform(matrix.inverse());
    return point.y;
  };

  const paintDragFrame = () => {
    frameRef.current = null;
    const drag = dragRef.current;
    if (!drag) return;
    drag.group.setAttribute("transform", `translate(${drag.baseX} ${drag.baseY + drag.latestDeltaY})`);
    if (drag.label) {
      drag.label.textContent = drag.snappedSteps === 0
        ? "현재 음정"
        : `${drag.snappedSteps > 0 ? "+" : ""}${drag.snappedSteps} step`;
      drag.label.style.display = "block";
    }
  };

  const scheduleDragFrame = () => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(paintDragFrame);
  };

  const beginNoteDrag = (
    event: ReactPointerEvent<SVGGElement>,
    note: NoteEvent,
    baseX: number,
    baseY: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    onSelectEvent(note.id);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      eventId: note.id,
      group: event.currentTarget,
      label: labelsRef.current.get(note.id) ?? null,
      baseX,
      baseY,
      startSvgY: clientToSvgY(event.clientY),
      latestDeltaY: 0,
      snappedSteps: 0,
    };
    event.currentTarget.classList.add("is-dragging");
  };

  const moveNoteDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    drag.latestDeltaY = clientToSvgY(event.clientY) - drag.startSvgY;
    drag.snappedSteps = Math.max(-28, Math.min(28, Math.round(-drag.latestDeltaY / DIATONIC_STEP)));
    scheduleDragFrame();
  };

  const finishNoteDrag = (event: ReactPointerEvent<SVGGElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    drag.latestDeltaY = clientToSvgY(event.clientY) - drag.startSvgY;
    drag.snappedSteps = Math.max(-28, Math.min(28, Math.round(-drag.latestDeltaY / DIATONIC_STEP)));
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    paintDragFrame();
    drag.group.classList.remove("is-dragging");
    if (drag.label) drag.label.style.display = "none";
    if (drag.group.hasPointerCapture(event.pointerId)) drag.group.releasePointerCapture(event.pointerId);
    dragRef.current = null;

    if (!cancelled && drag.snappedSteps !== 0) {
      onChangePitch(drag.eventId, drag.snappedSteps);
    } else {
      drag.group.setAttribute("transform", `translate(${drag.baseX} ${drag.baseY})`);
    }
  };

  const handleNoteKeyDown = (event: ReactKeyboardEvent<SVGGElement>, note: NoteEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onSelectEvent(note.id);
    onChangePitch(note.id, event.key === "ArrowUp" ? 1 : -1);
  };

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <div className="live-score">
      <svg
        ref={svgRef}
        className="live-score__page"
        viewBox={`0 0 ${PAGE_WIDTH} ${pageHeight}`}
        preserveAspectRatio="xMidYMin meet"
        role="img"
        aria-label={`${score.title} 실시간 악보 편집기`}
      >
        <rect className="live-score__paper" x={1} y={1} width={PAGE_WIDTH - 2} height={pageHeight - 2} rx={3} />
        <text className="live-score__title" x={PAGE_WIDTH / 2} y={58}>{score.title}</text>
        {score.subtitle && <text className="live-score__subtitle" x={PAGE_WIDTH / 2} y={84}>{score.subtitle}</text>}
        {score.composer && <text className="live-score__composer" x={PAGE_WIDTH - RIGHT_MARGIN} y={114}>{score.composer}</text>}
        <text className="live-score__tempo" x={LEFT_MARGIN} y={PAGE_TOP - 40}>
          {score.tempo ? `♩ = ${score.tempo}` : ""}
        </text>

        {score.staves.map((staff, staffIndex) => {
          const staffTop = PAGE_TOP + staffIndex * STAFF_GAP;
          const staffMiddle = staffTop + STAFF_SPACE * 2;
          const clef = staff.clef === "bass" ? "𝄢" : "𝄞";
          return (
            <g key={staff.id} className="live-score__staff">
              <text className="live-score__staff-name" x={LEFT_MARGIN - 40} y={staffMiddle + 4}>{staff.name}</text>
              <text className={`live-score__clef is-${staff.clef}`} x={LEFT_MARGIN + 7} y={staffMiddle + (staff.clef === "bass" ? 10 : 15)}>{clef}</text>
              <g className="live-score__time-signature" transform={`translate(${LEFT_MARGIN + 56} ${staffMiddle})`} aria-hidden="true">
                <text x={0} y={-2}>{score.time.numerator}</text>
                <text x={0} y={12}>{score.time.denominator}</text>
              </g>
              {Array.from({ length: 5 }, (_, lineIndex) => (
                <line
                  key={lineIndex}
                  className="live-score__staff-line"
                  x1={LEFT_MARGIN}
                  x2={PAGE_WIDTH - RIGHT_MARGIN}
                  y1={staffTop + lineIndex * STAFF_SPACE}
                  y2={staffTop + lineIndex * STAFF_SPACE}
                />
              ))}
              {measureNumbers.map((measure, measureIndex) => {
                const x = LEFT_MARGIN + measureIndex * measureWidth;
                return (
                  <g key={measure}>
                    <line className="live-score__barline" x1={x} x2={x} y1={staffTop} y2={staffTop + STAFF_SPACE * 4} />
                    {staffIndex === 0 && <text className="live-score__measure-number" x={x + 6} y={staffTop - 10}>{measure}</text>}
                  </g>
                );
              })}
              <line
                className="live-score__barline is-final"
                x1={PAGE_WIDTH - RIGHT_MARGIN}
                x2={PAGE_WIDTH - RIGHT_MARGIN}
                y1={staffTop}
                y2={staffTop + STAFF_SPACE * 4}
              />

              {staff.events.map((scoreEvent) => {
                if (scoreEvent.kind === "bar") return null;
                const measureIndex = Math.max(0, Math.min(measureNumbers.length - 1, scoreEvent.measure - 1));
                const beatRatio = Math.max(0, Math.min(1, scoreEvent.beat / Math.max(1, score.time.numerator)));
                const x = LEFT_MARGIN + measureIndex * measureWidth + measureWidth * (0.22 + beatRatio * 0.7);

                if (scoreEvent.kind === "rest") {
                  return (
                    <g
                      key={scoreEvent.id}
                      className={`live-score__event live-score__rest ${selectedEventId === scoreEvent.id ? "is-selected" : ""}`}
                      transform={`translate(${x} ${staffMiddle})`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${staff.name}, ${scoreEvent.duration}분쉼표`}
                      onPointerDown={() => onSelectEvent(scoreEvent.id)}
                    >
                      <rect className="live-score__hit-target" x={-17} y={-28} width={34} height={56} rx={6} />
                      <RestSymbol duration={scoreEvent.duration} dots={scoreEvent.dots} />
                    </g>
                  );
                }

                const y = staffMiddle + pitchY(scoreEvent, staff.clef);
                return (
                  <g
                    key={scoreEvent.id}
                    ref={(node) => {
                      if (node) groupsRef.current.set(scoreEvent.id, node);
                      else groupsRef.current.delete(scoreEvent.id);
                    }}
                    className={`live-score__event live-score__note ${selectedEventId === scoreEvent.id ? "is-selected" : ""}`}
                    transform={`translate(${x} ${y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={eventAriaLabel(scoreEvent, staff.name)}
                    onPointerDown={(event) => beginNoteDrag(event, scoreEvent, x, y)}
                    onPointerMove={moveNoteDrag}
                    onPointerUp={(event) => finishNoteDrag(event)}
                    onPointerCancel={(event) => finishNoteDrag(event, true)}
                    onLostPointerCapture={(event) => finishNoteDrag(event, true)}
                    onKeyDown={(event) => handleNoteKeyDown(event, scoreEvent)}
                  >
                    <rect className="live-score__hit-target" x={-21} y={-44} width={42} height={70} rx={7} />
                    <NoteSymbol note={scoreEvent} noteY={pitchY(scoreEvent, staff.clef)} />
                    <text
                      ref={(node) => {
                        if (node) labelsRef.current.set(scoreEvent.id, node);
                        else labelsRef.current.delete(scoreEvent.id);
                      }}
                      className="live-score__drag-label"
                      x={15}
                      y={-18}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
        {score.staves.length === 0 && (
          <text className="live-score__empty" x={PAGE_WIDTH / 2} y={pageHeight / 2}>표시할 파트가 없습니다.</text>
        )}
      </svg>
    </div>
  );
}
