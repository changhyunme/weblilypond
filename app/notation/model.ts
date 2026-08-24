export type PitchName = "c" | "d" | "e" | "f" | "g" | "a" | "b";

export type Accidental = "eses" | "es" | "" | "is" | "isis";

export type Duration = "1" | "2" | "4" | "8" | "16";

export type SourceRange = {
  start: number;
  end: number;
};

export type NoteEvent = {
  id: string;
  kind: "note";
  pitch: PitchName;
  accidental: Accidental;
  /** Scientific pitch notation: C4 is middle C. */
  octave: number;
  duration: Duration;
  dots: number;
  /** One-based measure number. */
  measure: number;
  /** Zero-based offset, expressed in beats of the score's time denominator. */
  beat: number;
  sourceRange?: SourceRange;
};

export type RestEvent = {
  id: string;
  kind: "rest";
  duration: Duration;
  dots: number;
  measure: number;
  beat: number;
  sourceRange?: SourceRange;
};

export type BarEvent = {
  id: string;
  kind: "bar";
  measure: number;
};

export type ScoreEvent = NoteEvent | RestEvent | BarEvent;

export type StaffModel = {
  id: string;
  name: string;
  shortName?: string;
  clef: "treble" | "bass";
  events: ScoreEvent[];
};

export type ScoreModel = {
  id: string;
  title: string;
  subtitle?: string;
  composer?: string;
  time: {
    numerator: number;
    denominator: number;
  };
  key: {
    tonic: PitchName;
    mode: "major" | "minor";
  };
  tempo?: number;
  staves: StaffModel[];
  sourceVersion: number;
};

/**
 * Produces a deterministic, CSS/DOM-safe identifier from stable semantic parts.
 * FNV-1a keeps IDs compact while the readable prefix remains useful in devtools.
 */
export function stableId(namespace: string, ...parts: ReadonlyArray<string | number>): string {
  const input = [namespace, ...parts].join("\u001f");
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  const prefix = namespace
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "id";

  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/** Alias for call sites that prefer an explicit factory-style name. */
export const createStableId = stableId;

export function updateNote(
  model: ScoreModel,
  eventId: string,
  patch: Partial<Omit<NoteEvent, "id" | "kind">>,
): ScoreModel {
  let changed = false;

  const staves = model.staves.map((staff) => {
    let staffChanged = false;
    const events = staff.events.map((event) => {
      if (event.kind !== "note" || event.id !== eventId) return event;

      const updated: NoteEvent = { ...event, ...patch, id: event.id, kind: "note" };
      const hasDifference = (Object.keys(patch) as Array<keyof typeof patch>).some(
        (key) => updated[key] !== event[key],
      );

      if (!hasDifference) return event;
      changed = true;
      staffChanged = true;
      return updated;
    });

    return staffChanged ? { ...staff, events } : staff;
  });

  return changed ? { ...model, staves, sourceVersion: model.sourceVersion + 1 } : model;
}

const PITCHES: ReadonlyArray<PitchName> = ["c", "d", "e", "f", "g", "a", "b"];

export function transposeNoteDiatonic(
  model: ScoreModel,
  eventId: string,
  steps: number,
): ScoreModel {
  if (!Number.isFinite(steps)) return model;
  const wholeSteps = Math.trunc(steps);
  if (wholeSteps === 0) return model;

  for (const staff of model.staves) {
    const event = staff.events.find(
      (candidate): candidate is NoteEvent => candidate.kind === "note" && candidate.id === eventId,
    );
    if (!event) continue;

    const absoluteStep = event.octave * PITCHES.length + PITCHES.indexOf(event.pitch) + wholeSteps;
    const pitchIndex = ((absoluteStep % PITCHES.length) + PITCHES.length) % PITCHES.length;
    const octave = Math.floor(absoluteStep / PITCHES.length);
    return updateNote(model, eventId, { pitch: PITCHES[pitchIndex], octave });
  }

  return model;
}

export function eventsForMeasure(
  model: ScoreModel,
  measure: number,
  staffId?: string,
): ScoreEvent[] {
  return model.staves
    .filter((staff) => staffId === undefined || staff.id === staffId)
    .flatMap((staff) => staff.events.filter((event) => event.measure === measure));
}

export function totalMeasures(model: ScoreModel): number {
  let maximum = 0;
  for (const staff of model.staves) {
    for (const event of staff.events) maximum = Math.max(maximum, event.measure);
  }
  return maximum;
}
