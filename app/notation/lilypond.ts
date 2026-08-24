import {
  type Accidental,
  type BarEvent,
  type Duration,
  type NoteEvent,
  type PitchName,
  type RestEvent,
  type ScoreEvent,
  type ScoreModel,
  type StaffModel,
  stableId,
} from "./model";

const PITCHES: ReadonlyArray<PitchName> = ["c", "d", "e", "f", "g", "a", "b"];
const ACCIDENTALS = new Set<Accidental>(["eses", "es", "", "is", "isis"]);
const DURATIONS = new Set<Duration>(["1", "2", "4", "8", "16"]);

type Block = {
  body: string;
  bodyStart: number;
  end: number;
};

type MusicVariable = Block & {
  name: string;
  relativeAnchor?: string;
};

type StaffReference = {
  variable?: string;
  directMusic?: Block;
  name?: string;
  shortName?: string;
};

function extractBalancedBlock(source: string, openIndex: number): Block | null {
  if (source[openIndex] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inComment) {
      if (character === "\n") inComment = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === "%") {
      inComment = true;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          body: source.slice(openIndex + 1, index),
          bodyStart: openIndex + 1,
          end: index + 1,
        };
      }
    }
  }
  return null;
}

function maskCommentsAndStrings(source: string): string {
  // split("") deliberately preserves UTF-16 code-unit offsets used by JS slices.
  const characters = source.split("");
  let inString = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (inComment) {
      if (character === "\n") inComment = false;
      else characters[index] = " ";
      continue;
    }
    if (inString) {
      characters[index] = character === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === "%") {
      inComment = true;
      characters[index] = " ";
    } else if (character === '"') {
      inString = true;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function stringProperty(source: string, property: string): string | undefined {
  const match = source.match(new RegExp(`\\b${property}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`));
  return match?.[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function findNamedBlocks(source: string): Map<string, MusicVariable> {
  const variables = new Map<string, MusicVariable>();
  const assignment = /\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:\\relative\s+([a-g](?:(?:isis|eses|is|es))?[',]*)\s*)?\{/g;
  let match: RegExpExecArray | null;

  while ((match = assignment.exec(source))) {
    const openIndex = assignment.lastIndex - 1;
    const block = extractBalancedBlock(source, openIndex);
    if (!block) continue;
    variables.set(match[1], { ...block, name: match[1], relativeAnchor: match[2] });
    assignment.lastIndex = block.end;
  }
  return variables;
}

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function findStaffReferences(source: string): StaffReference[] {
  const references: StaffReference[] = [];
  const staffPattern = /\\new\s+Staff\b/g;
  let match: RegExpExecArray | null;

  while ((match = staffPattern.exec(source))) {
    let cursor = skipWhitespace(source, staffPattern.lastIndex);
    let settings = "";
    if (source.startsWith("\\with", cursor)) {
      cursor = skipWhitespace(source, cursor + "\\with".length);
      const settingsBlock = extractBalancedBlock(source, cursor);
      if (!settingsBlock) continue;
      settings = settingsBlock.body;
      cursor = skipWhitespace(source, settingsBlock.end);
    }
    const musicBlock = extractBalancedBlock(source, cursor);
    if (!musicBlock) continue;
    const variable = musicBlock.body.trim().match(/^\\([A-Za-z][A-Za-z0-9_]*)$/)?.[1];
    references.push({
      variable,
      directMusic: musicBlock,
      name: stringProperty(settings, "instrumentName"),
      shortName: stringProperty(settings, "shortInstrumentName"),
    });
    staffPattern.lastIndex = musicBlock.end;
  }
  return references;
}

function headerMetadata(source: string): Pick<ScoreModel, "title" | "subtitle" | "composer"> {
  const headerMatch = /\\header\s*\{/g.exec(source);
  const block = headerMatch ? extractBalancedBlock(source, headerMatch.index + headerMatch[0].lastIndexOf("{")) : null;
  const header = block?.body ?? "";
  const title = stringProperty(header, "title") ?? "Untitled Score";
  const subtitle = stringProperty(header, "subtitle");
  const composer = stringProperty(header, "composer");
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(composer ? { composer } : {}),
  };
}

function scoreSettings(source: string): Pick<ScoreModel, "time" | "key" | "tempo"> {
  const timeMatch = source.match(/\\time\s+(\d+)\s*\/\s*(\d+)/);
  const keyMatch = source.match(/\\key\s+([a-g])(?:isis|eses|is|es)?\s+\\(major|minor)\b/);
  const tempoMatch = source.match(/\\tempo\b(?:\s+"[^"]*")?\s+(?:\d+\s*=\s*)?(\d+)/);
  const numerator = Number(timeMatch?.[1] ?? 4);
  const denominator = Number(timeMatch?.[2] ?? 4);
  const tempo = tempoMatch ? Number(tempoMatch[1]) : undefined;
  return {
    time: {
      numerator: Number.isFinite(numerator) && numerator > 0 ? numerator : 4,
      denominator: Number.isFinite(denominator) && denominator > 0 ? denominator : 4,
    },
    key: {
      tonic: (keyMatch?.[1] as PitchName | undefined) ?? "c",
      mode: (keyMatch?.[2] as "major" | "minor" | undefined) ?? "major",
    },
    ...(tempo !== undefined && Number.isFinite(tempo) ? { tempo } : {}),
  };
}

function absolutePitch(token: string): number {
  const match = token.match(/^([a-g])(?:(?:isis|eses|is|es))?([',]*)/);
  const pitch = (match?.[1] as PitchName | undefined) ?? "c";
  const markers = match?.[2] ?? "";
  const octave = 3 + [...markers].filter((marker) => marker === "'").length - [...markers].filter((marker) => marker === ",").length;
  return octave * PITCHES.length + PITCHES.indexOf(pitch);
}

function relativePitch(previous: number, pitch: PitchName, markers: string): number {
  const pitchIndex = PITCHES.indexOf(pitch);
  let candidate = Math.floor(previous / PITCHES.length) * PITCHES.length + pitchIndex;
  if (candidate - previous > 3) candidate -= PITCHES.length;
  if (candidate - previous < -3) candidate += PITCHES.length;
  for (const marker of markers) candidate += marker === "'" ? PITCHES.length : -PITCHES.length;
  return candidate;
}

function durationBeats(duration: Duration, dots: number, denominator: number): number {
  let multiplier = 1;
  let addition = 0.5;
  for (let index = 0; index < dots; index += 1) {
    multiplier += addition;
    addition /= 2;
  }
  return (denominator / Number(duration)) * multiplier;
}

function maskDirectives(source: string): string {
  return source
    .replace(/\\key\s+[a-g](?:isis|eses|is|es)?\s+\\(?:major|minor)\b/g, (value) => " ".repeat(value.length))
    .replace(/\\time\s+\d+\s*\/\s*\d+/g, (value) => " ".repeat(value.length))
    .replace(/\\tempo\b(?:\s+"[^"]*")?\s+(?:\d+\s*=\s*)?\d+/g, (value) => " ".repeat(value.length))
    .replace(/\\clef\s+(?:"(?:treble|bass)"|treble|bass)/g, (value) => " ".repeat(value.length));
}

function parseEvents(
  variable: MusicVariable | Block,
  staffId: string,
  denominator: number,
  relativeAnchor?: string,
): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  const cleaned = maskDirectives(maskCommentsAndStrings(variable.body));
  const tokenPattern = /\\bar\b|(?<![A-Za-z\\])([a-g])((?:isis|eses|is|es)?)([',]*)(16|8|4|2|1)?(\.*)(?![A-Za-z0-9])|(?<![A-Za-z\\])r(16|8|4|2|1)?(\.*)(?![A-Za-z0-9])|\|/g;
  let match: RegExpExecArray | null;
  let measure = 1;
  let beat = 0;
  let eventOrdinal = 0;
  let inheritedDuration: Duration = "4";
  let previousPitch = relativeAnchor ? absolutePitch(relativeAnchor) : 0;

  while ((match = tokenPattern.exec(cleaned))) {
    const token = match[0];
    if (token === "|" || token === "\\bar") {
      const bar: BarEvent = {
        id: stableId("event", staffId, "bar", eventOrdinal),
        kind: "bar",
        measure,
      };
      events.push(bar);
      eventOrdinal += 1;
      measure += 1;
      beat = 0;
      continue;
    }

    const start = variable.bodyStart + match.index;
    const end = start + token.length;
    if (match[1]) {
      const pitch = match[1] as PitchName;
      const accidental = ACCIDENTALS.has(match[2] as Accidental) ? (match[2] as Accidental) : "";
      const markers = match[3] ?? "";
      const explicitDuration = match[4] as Duration | undefined;
      const duration: Duration = explicitDuration && DURATIONS.has(explicitDuration) ? explicitDuration : inheritedDuration;
      const dots = match[5]?.length ?? 0;
      const absolute = relativeAnchor
        ? relativePitch(previousPitch, pitch, markers)
        : (3 + [...markers].filter((marker) => marker === "'").length - [...markers].filter((marker) => marker === ",").length) * PITCHES.length + PITCHES.indexOf(pitch);
      previousPitch = absolute;
      inheritedDuration = duration;
      const note: NoteEvent = {
        id: stableId("event", staffId, "note", eventOrdinal),
        kind: "note",
        pitch,
        accidental,
        octave: Math.floor(absolute / PITCHES.length),
        duration,
        dots,
        measure,
        beat,
        sourceRange: { start, end },
      };
      events.push(note);
      beat += durationBeats(duration, dots, denominator);
    } else {
      const explicitDuration = match[6] as Duration | undefined;
      const duration: Duration = explicitDuration && DURATIONS.has(explicitDuration) ? explicitDuration : inheritedDuration;
      const dots = match[7]?.length ?? 0;
      inheritedDuration = duration;
      const rest: RestEvent = {
        id: stableId("event", staffId, "rest", eventOrdinal),
        kind: "rest",
        duration,
        dots,
        measure,
        beat,
        sourceRange: { start, end },
      };
      events.push(rest);
      beat += durationBeats(duration, dots, denominator);
    }
    eventOrdinal += 1;
  }
  return events;
}

function clefFor(source: string): "treble" | "bass" {
  return /\\clef\s+(?:"bass"|bass)\b/.test(source) ? "bass" : "treble";
}

export function parseLilyPond(source: string): ScoreModel {
  const variables = findNamedBlocks(source);
  const references = findStaffReferences(source);
  const metadata = headerMetadata(source);
  const settings = scoreSettings(source);
  const inferredReferences: StaffReference[] = references.length > 0
    ? references
    : [...variables.values()]
        .filter((variable) => variable.name !== "global" && /music$/i.test(variable.name))
        .map((variable) => ({ variable: variable.name }));

  const staves: StaffModel[] = inferredReferences.flatMap((reference, index) => {
    const variable = reference.variable ? variables.get(reference.variable) : undefined;
    const music = variable ?? reference.directMusic;
    if (!music) return [];
    const linkedName = variable ? reference.variable : undefined;
    const name = reference.name ?? linkedName ?? `Staff ${index + 1}`;
    const staffId = stableId("staff", name, index);
    const staff: StaffModel = {
      id: staffId,
      name,
      ...(reference.shortName ? { shortName: reference.shortName } : {}),
      clef: clefFor(music.body),
      events: parseEvents(music, staffId, settings.time.denominator, variable?.relativeAnchor),
    };
    return [staff];
  });

  return {
    id: stableId("score", metadata.title),
    ...metadata,
    ...settings,
    staves,
    sourceVersion: 1,
  };
}

function escapeLilyString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function variableName(staff: StaffModel, index: number): string {
  const base = staff.name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/(?:^|\s+)([A-Za-z0-9])/g, (_match, character: string) => character.toUpperCase())
    .replace(/^([A-Z])/, (character) => character.toLowerCase());
  const safeBase = /^[A-Za-z]/.test(base) ? base : `staff${index + 1}`;
  return `${safeBase}Music`;
}

function pitchToken(note: NoteEvent): string {
  const octaveDifference = note.octave - 3;
  const octave = octaveDifference >= 0 ? "'".repeat(octaveDifference) : ",".repeat(-octaveDifference);
  return `${note.pitch}${note.accidental}${octave}${note.duration}${".".repeat(note.dots)}`;
}

function eventToken(event: ScoreEvent): string {
  if (event.kind === "note") return pitchToken(event);
  if (event.kind === "rest") return `r${event.duration}${".".repeat(event.dots)}`;
  return "|";
}

function serializeStaffMusic(staff: StaffModel): string {
  const lines: string[] = [];
  let current: string[] = [];
  for (const event of staff.events) {
    current.push(eventToken(event));
    if (event.kind === "bar") {
      lines.push(`  ${current.join(" ")}`);
      current = [];
    }
  }
  if (current.length > 0) lines.push(`  ${current.join(" ")}`);
  return lines.join("\n");
}

export function serializeLilyPond(model: ScoreModel): string {
  const usedNames = new Set<string>();
  const names = model.staves.map((staff, index) => {
    const base = variableName(staff, index);
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    usedNames.add(candidate);
    return candidate;
  });
  const header = [
    "\\version \"2.26.0\"",
    "",
    "\\header {",
    `  title = "${escapeLilyString(model.title)}"`,
    ...(model.subtitle ? [`  subtitle = "${escapeLilyString(model.subtitle)}"`] : []),
    ...(model.composer ? [`  composer = "${escapeLilyString(model.composer)}"`] : []),
    "  tagline = ##f",
    "}",
    "",
    "global = {",
    `  \\key ${model.key.tonic} \\${model.key.mode}`,
    `  \\time ${model.time.numerator}/${model.time.denominator}`,
    ...(model.tempo ? [`  \\tempo 4 = ${model.tempo}`] : []),
    "}",
  ];
  const variables = model.staves.flatMap((staff, index) => [
    "",
    `${names[index]} = {`,
    "  \\global",
    ...(staff.clef === "bass" ? ["  \\clef bass"] : []),
    serializeStaffMusic(staff),
    "}",
  ]);
  const score = [
    "",
    "\\score {",
    "  \\new StaffGroup <<",
    ...model.staves.map((staff, index) => {
      const shortName = staff.shortName
        ? ` shortInstrumentName = "${escapeLilyString(staff.shortName)}"`
        : "";
      return `    \\new Staff \\with { instrumentName = "${escapeLilyString(staff.name)}"${shortName} } { \\${names[index]} }`;
    }),
    "  >>",
    "  \\layout { }",
    "  \\midi { }",
    "}",
  ];
  return [...header, ...variables, ...score].join("\n");
}
