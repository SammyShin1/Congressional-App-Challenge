/* eslint-disable react-hooks/refs */
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  PanResponder,
  Text,
  TextInput,
  Pressable,
  Platform,
} from "react-native";
import Svg, { Path, Line, Text as SvgText } from "react-native-svg";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { createAudioPlayer } from "expo-audio";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { parse } from "mathjs";

// ------------------------------------------------------------------
// SHARED GEOMETRY HELPERS
// ------------------------------------------------------------------

// Distance from a point to a line segment
function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const nearX = x1 + t * dx;
  const nearY = y1 + t * dy;

  return Math.hypot(px - nearX, py - nearY);
}

type Point = { x: number; y: number };

const MAX_HAPTIC_DISTANCE = 40;
const LINE_CHORD_DISTANCE = 10;
const VERTEX_HITBOX_RADIUS = 24;
const BASE_TONE_FREQUENCY = 261.63; // C4
const LINE_TONE_FREQUENCY = 329.63; // E4
const VERTEX_TONE_FREQUENCY = 392.0; // G4
const TONE_SOURCES = [
  require("../../assets/audio/base-c4.wav"),
  require("../../assets/audio/line-e4.wav"),
  require("../../assets/audio/vertex-g4.wav"),
];

// Holding a finger still this long (within DWELL_JITTER_PX) announces the
// nearest corner.
const DWELL_MS = 1000;
const DWELL_JITTER_PX = 10;
const ON_CORNER_PX = 10;

function crossProduct(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abc = crossProduct(a, b, c);
  const abd = crossProduct(a, b, d);
  const cda = crossProduct(c, d, a);
  const cdb = crossProduct(c, d, b);
  return abc * abd < 0 && cda * cdb < 0;
}

function isValidQuadrilateral(points: Point[]) {
  if (points.length !== 4) return false;

  for (let first = 0; first < points.length; first++) {
    for (let second = first + 1; second < points.length; second++) {
      for (let third = second + 1; third < points.length; third++) {
        if (Math.abs(crossProduct(points[first], points[second], points[third])) < 1e-6) {
          return false;
        }
      }
    }
  }

  return (
    !segmentsIntersect(points[0], points[1], points[2], points[3]) &&
    !segmentsIntersect(points[1], points[2], points[3], points[0])
  );
}

// Distance from a point to the nearest segment across a set of polylines
// (each "stroke" is one continuous piece of curve; graphs can have several,
// e.g. either side of an asymptote like 1/x)
function distanceToStrokes(px: number, py: number, strokes: Point[][]) {
  let min = Infinity;
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length - 1; i++) {
      const a = stroke[i];
      const b = stroke[i + 1];
      const d = distToSegment(px, py, a.x, a.y, b.x, b.y);
      if (d < min) min = d;
    }
  }
  return min;
}

// Samples a function across [xMin, xMax], converts each sample to a screen
// point, and splits it into separate "strokes" wherever there's a gap
// (undefined value) or a huge jump (an asymptote), so we never draw or
// feel a phantom wall connecting two unrelated branches of the curve.
function sampleFunctionToStrokes(
  evaluate: (scope: { x: number }) => number,
  xMin: number,
  xMax: number,
  toScreenFn: (gx: number, gy: number) => Point,
  sampleCount: number,
  maxJumpPx: number
): Point[][] {
  const rawPoints: (Point | null)[] = [];

  for (let i = 0; i <= sampleCount; i++) {
    const gx = xMin + (i / sampleCount) * (xMax - xMin);
    let gy: number;
    try {
      gy = evaluate({ x: gx });
    } catch {
      gy = NaN;
    }
    rawPoints.push(
      typeof gy === "number" && isFinite(gy) ? toScreenFn(gx, gy) : null
    );
  }

  const strokes: Point[][] = [];
  let current: Point[] = [];

  for (const p of rawPoints) {
    if (!p) {
      if (current.length > 1) strokes.push(current);
      current = [];
      continue;
    }
    const prev = current[current.length - 1];
    if (prev && Math.abs(p.y - prev.y) > maxJumpPx) {
      if (current.length > 1) strokes.push(current);
      current = [p];
      continue;
    }
    current.push(p);
  }
  if (current.length > 1) strokes.push(current);

  return strokes;
}

// ------------------------------------------------------------------
// TRIANGLE (SHAPE) MODE
// ------------------------------------------------------------------

const TRIANGLE: Point[] = [
  { x: 100, y: 150 }, // top
  { x: 250, y: 500 }, // bottom left
  { x: 50, y: 500 }, // bottom right
];

function distanceToShape(px: number, py: number, shape: Point[]) {
  return Math.min(
    ...shape.map((point, index) => {
      const next = shape[(index + 1) % shape.length];
      return distToSegment(px, py, point.x, point.y, next.x, next.y);
    })
  );
}

// Real corners only. Shapes like circles are stored as many small segments;
// those joints turn by just a few degrees and should not count as corners
// (no corner haptic, no corner dot, no corner announcement).
const CORNER_TURN_DEGREES = 20;

function findCorners(shape: Point[]): Point[] {
  // Drop duplicate consecutive points (e.g. a closed ellipse repeats its start).
  const pts = shape.filter((p, i) => {
    const q = shape[(i + 1) % shape.length];
    return Math.hypot(p.x - q.x, p.y - q.y) > 0.5;
  });
  const n = pts.length;
  if (n < 3) return pts;

  return pts.filter((point, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const a1 = Math.atan2(point.y - prev.y, point.x - prev.x);
    const a2 = Math.atan2(next.y - point.y, next.x - point.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = Math.PI * 2 - turn;
    return (turn * 180) / Math.PI >= CORNER_TURN_DEGREES;
  });
}

// Screen coordinates: +y points DOWN.
function directionWords(dx: number, dy: number) {
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI; // 0 = right, 90 = up
  const sector = Math.round(((angle + 360) % 360) / 45) % 8;
  return [
    "right",
    "up and to the right",
    "up",
    "up and to the left",
    "left",
    "down and to the left",
    "down",
    "down and to the right",
  ][sector];
}

function regularPolygon(sides: number): Point[] {
  const centerX = 150;
  const centerY = 325;
  const radius = 175;
  const startAngle = -Math.PI / 2;

  return Array.from({ length: sides }, (_, index) => {
    const angle = startAngle + (index * Math.PI * 2) / sides;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });
}

function ellipsePoints(radiusX: number, radiusY: number, count = 40, start = 0, end = Math.PI * 2) {
  return Array.from({ length: count }, (_, index) => {
    const angle = start + ((end - start) * index) / (count - 1);
    return { x: 150 + Math.cos(angle) * radiusX, y: 325 + Math.sin(angle) * radiusY };
  });
}

function randomQuadrilateral(): Point[] {
  const minDistance = 90;
  for (let attempt = 0; attempt < 500; attempt++) {
    const points = Array.from({ length: 4 }, () => ({
      x: 55 + Math.random() * 190,
      y: 80 + Math.random() * 390,
    }));
    const pointsAreSeparated = points.every((point, index) =>
      points.slice(index + 1).every(
        (other) => Math.hypot(point.x - other.x, point.y - other.y) >= minDistance
      )
    );
    if (!pointsAreSeparated) continue;

    const center = points.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 }
    );
    const sortedPoints = points.sort(
      (a, b) =>
        Math.atan2(a.y - center.y, a.x - center.x) -
        Math.atan2(b.y - center.y, b.x - center.x)
    );
    if (isValidQuadrilateral(sortedPoints)) return sortedPoints;
  }

  return regularPolygon(4);
}

function starPoints(points = 5): Point[] {
  return Array.from({ length: points * 2 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    const radius = index % 2 === 0 ? 175 : 78;
    return { x: 150 + Math.cos(angle) * radius, y: 325 + Math.sin(angle) * radius };
  });
}

function triangleVariant(type: string): Point[] {
  if (type === "right") return [{ x: 65, y: 470 }, { x: 65, y: 100 }, { x: 245, y: 470 }];
  if (type === "isosceles" || type === "equilateral") return regularPolygon(3);
  if (type === "obtuse") return [{ x: 35, y: 450 }, { x: 270, y: 410 }, { x: 155, y: 100 }];
  if (type === "acute") return [{ x: 55, y: 450 }, { x: 245, y: 450 }, { x: 150, y: 135 }];
  return [{ x: 45, y: 450 }, { x: 250, y: 425 }, { x: 125, y: 100 }];
}

function namedShape(normalized: string): Point[] | null {
  if (normalized.includes("semicircle")) return ellipsePoints(145, 145, 24, Math.PI, Math.PI * 2).concat([{ x: 5, y: 325 }]);
  if (normalized.includes("quarter circle")) return ellipsePoints(145, 145, 24, Math.PI * 1.5, Math.PI * 2).concat([{ x: 150, y: 325 }, { x: 150, y: 180 }]);
  if (normalized.includes("circle")) return ellipsePoints(145, 145);
  if (normalized.includes("oval")) return ellipsePoints(145, 95);
  if (normalized.includes("heart")) return [{ x: 150, y: 480 }, { x: 35, y: 270 }, { x: 45, y: 170 }, { x: 105, y: 135 }, { x: 150, y: 185 }, { x: 195, y: 135 }, { x: 255, y: 170 }, { x: 265, y: 270 }];
  if (normalized.includes("crescent")) return [{ x: 235, y: 90 }, { x: 125, y: 120 }, { x: 80, y: 230 }, { x: 105, y: 365 }, { x: 210, y: 465 }, { x: 155, y: 350 }, { x: 135, y: 250 }, { x: 155, y: 155 }];
  if (normalized.includes("cross")) return [{ x: 110, y: 70 }, { x: 190, y: 70 }, { x: 190, y: 230 }, { x: 270, y: 230 }, { x: 270, y: 310 }, { x: 190, y: 310 }, { x: 190, y: 480 }, { x: 110, y: 480 }, { x: 110, y: 310 }, { x: 30, y: 310 }, { x: 30, y: 230 }, { x: 110, y: 230 }];
  if (normalized.includes("arrow")) return [{ x: 30, y: 280 }, { x: 180, y: 280 }, { x: 180, y: 205 }, { x: 270, y: 325 }, { x: 180, y: 445 }, { x: 180, y: 370 }, { x: 30, y: 370 }];
  if (normalized.includes("star")) return starPoints();
  if (normalized.includes("kite")) return [{ x: 150, y: 70 }, { x: 245, y: 270 }, { x: 150, y: 480 }, { x: 55, y: 270 }];
  if (normalized.includes("rhombus")) return [{ x: 150, y: 70 }, { x: 260, y: 325 }, { x: 150, y: 480 }, { x: 40, y: 325 }];
  if (normalized.includes("trapezoid")) return [{ x: 90, y: 90 }, { x: 210, y: 90 }, { x: 265, y: 470 }, { x: 35, y: 470 }];
  if (normalized.includes("parallelogram")) return [{ x: 85, y: 90 }, { x: 265, y: 90 }, { x: 215, y: 470 }, { x: 35, y: 470 }];
  if (normalized.includes("rectangle")) return [{ x: 45, y: 110 }, { x: 255, y: 110 }, { x: 255, y: 450 }, { x: 45, y: 450 }];
  if (normalized.includes("square")) return regularPolygon(4);
  return null;
}

function shapeFromPrompt(prompt: string): Point[] | null {
  const normalized = prompt.trim().toLowerCase();
  const numberMatch = normalized.match(/\b(\d+)\s*(?:[- ]?sided|[- ]?gon)\b/);
  const namedSides: Record<string, number> = {
    triangle: 3,
    quadrilateral: 4,
    pentagon: 5,
    hexagon: 6,
    heptagon: 7,
    octagon: 8,
    nonagon: 9,
    decagon: 10,
    dodecagon: 12,
  };

  if (normalized.includes("quadrilateral") || (normalized.includes("random") && normalized.includes("4"))) {
    return randomQuadrilateral();
  }

  const commonShape = namedShape(normalized);
  if (commonShape) return commonShape;

  if (normalized.includes("equilateral") || normalized.includes("isosceles") || normalized.includes("scalene") || normalized.includes("right triangle") || normalized.includes("acute triangle") || normalized.includes("obtuse triangle")) {
    const type = normalized.match(/equilateral|isosceles|scalene|right|acute|obtuse/)?.[0] ?? "scalene";
    return triangleVariant(type);
  }

  const sides = numberMatch
    ? Number(numberMatch[1])
    : Object.entries(namedSides).find(([name]) => normalized.includes(name))?.[1];
  return sides && sides >= 3 && sides <= 12 ? regularPolygon(sides) : null;
}

function fitShapeToCanvas(shape: Point[], width: number, height: number): Point[] {
  if (width <= 0 || height <= 0) return shape;
  const margin = 28;
  const minX = Math.min(...shape.map((point) => point.x));
  const maxX = Math.max(...shape.map((point) => point.x));
  const minY = Math.min(...shape.map((point) => point.y));
  const maxY = Math.max(...shape.map((point) => point.y));
  const scale =
    Math.min(
      (width - margin * 2) / Math.max(maxX - minX, 1),
      (height - margin * 2) / Math.max(maxY - minY, 1)
    ) * 0.82;
  const shapeWidth = (maxX - minX) * scale;
  const shapeHeight = (maxY - minY) * scale;
  const offsetX = (width - shapeWidth) / 2 - minX * scale;
  const offsetY = (height - shapeHeight) / 2 - minY * scale;
  return shape.map((point) => ({ x: point.x * scale + offsetX, y: point.y * scale + offsetY }));
}

function TriangleEdge({ a, b }: { a: Point; b: Point }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  const centerX = (a.x + b.x) / 2;
  const centerY = (a.y + b.y) / 2;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: centerX - length / 2,
        top: centerY - 2,
        width: length,
        height: 4,
        backgroundColor: "white",
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

function ShapeVertex({ point }: { point: Point }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: point.x - 5,
        top: point.y - 5,
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: "#62a8ff",
        borderWidth: 2,
        borderColor: "white",
      }}
    />
  );
}

// ------------------------------------------------------------------
// GRAPH (EQUATION) MODE
// ------------------------------------------------------------------

// Fixed visible graph window, in math units (zooming was removed).
const HOME_X_MIN = -10;
const HOME_X_MAX = 10;
const HOME_Y_MIN = -10;
const HOME_Y_MAX = 10;
const SAMPLE_COUNT = 600;
const GRID_MIN_SPACING_PX = 45;

// ------------------------------------------------------------------
// EQUATION TEXT NORMALIZATION (plain text AND LaTeX)
// ------------------------------------------------------------------

function skipSpaces(text: string, i: number) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// Index of the bracket that closes the one at `openIndex`, or -1.
function findMatching(text: string, openIndex: number, open = "(", close = ")") {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Reads a TeX argument starting at i: either {...} or a single character.
function readLatexArgument(
  text: string,
  start: number
): { content: string; end: number } | null {
  const i = skipSpaces(text, start);
  if (i >= text.length) return null;
  if (text[i] === "{") {
    const close = findMatching(text, i, "{", "}");
    if (close < 0) return null;
    return { content: text.slice(i + 1, close), end: close + 1 };
  }
  if (/[A-Za-z0-9]/.test(text[i])) return { content: text[i], end: i + 1 };
  return null;
}

function convertLatexFractions(input: string) {
  let text = input;
  const re = /\\[dt]?frac\b\s*/;
  for (let guard = 0; guard < 50; guard++) {
    const m = re.exec(text);
    if (!m) break;
    const afterCommand = m.index + m[0].length;
    const num = readLatexArgument(text, afterCommand);
    const den = num ? readLatexArgument(text, num.end) : null;
    if (!num || !den) {
      // malformed: drop the command so we never loop forever
      text = text.slice(0, m.index) + text.slice(afterCommand);
      continue;
    }
    text =
      text.slice(0, m.index) +
      `((${num.content})/(${den.content}))` +
      text.slice(den.end);
  }
  return text;
}

function convertLatexRoots(input: string) {
  let text = input;
  const re = /\\sqrt\b\s*(?:\[([^\]]*)\])?\s*/;
  for (let guard = 0; guard < 50; guard++) {
    const m = re.exec(text);
    if (!m) break;
    const afterCommand = m.index + m[0].length;
    const arg = readLatexArgument(text, afterCommand);
    if (!arg) {
      text = text.slice(0, m.index) + text.slice(afterCommand);
      continue;
    }
    const replacement = m[1]
      ? `nthRoot(${arg.content}, ${m[1]})`
      : `sqrt(${arg.content})`;
    text = text.slice(0, m.index) + replacement + text.slice(arg.end);
  }
  return text;
}

// "sin x", "sin^2 x", "sin 2x", "ln x" -> real function calls mathjs can parse.
function applyLatexFunctionArguments(text: string) {
  const re = /\b(asin|acos|atan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|ln|log|exp)\b/;
  let out = "";
  let rest = text;

  for (let guard = 0; guard < 200; guard++) {
    const m = re.exec(rest);
    if (!m) break;
    out += rest.slice(0, m.index);
    const name = m[1];
    let k = skipSpaces(rest, m.index + m[0].length);

    let power = "";
    if (rest[k] === "^") {
      k = skipSpaces(rest, k + 1);
      if (rest[k] === "(") {
        const close = findMatching(rest, k);
        if (close > 0) {
          power = rest.slice(k + 1, close);
          k = close + 1;
        }
      } else {
        const pm = /^-?\d+/.exec(rest.slice(k));
        if (pm) {
          power = pm[0];
          k += pm[0].length;
        }
      }
    }

    k = skipSpaces(rest, k);
    let arg = "";
    let end = k;
    if (rest[k] === "(") {
      const close = findMatching(rest, k);
      if (close < 0) {
        arg = rest.slice(k + 1);
        end = rest.length;
      } else {
        arg = rest.slice(k + 1, close);
        end = close + 1;
      }
    } else {
      const am = /^-?(?:\d+(?:\.\d+)?)?(?:pi|[a-zA-Z])?(?:\^-?(?:\d+|[a-zA-Z]))?/.exec(
        rest.slice(k)
      );
      arg = am ? am[0] : "";
      end = k + arg.length;
    }

    const call = `${name}(${arg})`;
    out += power ? `(${call})^(${power})` : call;
    rest = rest.slice(end);
  }

  return out + rest;
}

// Converts LaTeX like \frac{x^2}{4}, \sin x, \sqrt[3]{x}, e^{-x}, \pi,
// \left|x\right|, \log_2(x) into text mathjs can parse.
function latexToMathjs(input: string) {
  let t = input.replace(/\$/g, "");

  t = t.replace(/\\(?:left|right|displaystyle|bigg?|Bigg?|quad|qquad)(?![a-zA-Z])\s*/g, "");
  t = t.replace(/\\[,;:!]/g, " ").replace(/\\ /g, " ");
  t = t.replace(/\\[lr]vert\b/g, "|");
  t = t.replace(/\\operatorname\{(\w+)\}/g, "$1");

  t = convertLatexFractions(t);
  t = convertLatexRoots(t);

  // \log_2(x) and \log_{2} x -> log(x, 2)
  t = t.replace(/\\log_\{?([0-9a-zA-Z.]+)\}?\s*\(([^()]*)\)/g, "log($2, $1)");
  t = t.replace(/\\log_\{?([0-9a-zA-Z.]+)\}?\s*([0-9a-zA-Z]+)/g, "log($2, $1)");

  t = t.replace(/\\cdot|\\times/g, "*").replace(/\\div/g, "/");
  t = t.replace(/\\pi\b/g, " pi ");
  t = t.replace(/\\arc(sin|cos|tan)\b/g, "a$1");
  t = t.replace(/\\(sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|exp|ln|log)\b/g, " $1 ");

  t = t.replace(/\{/g, "(").replace(/\}/g, ")");
  t = t.replace(/\|([^|]*)\|/g, "abs($1)");
  t = applyLatexFunctionArguments(t);

  return t.replace(/\\/g, "");
}

function isLatexLike(text: string) {
  return /\\|[{}]|\$/.test(text);
}

// In mathjs, log() is the natural log. For a graphing tool, log(x) should be
// base 10 and ln(x) natural (like Desmos / graphing calculators). Two-argument
// log(x, base) is left alone.
function hasTopLevelComma(text: string, openIndex: number) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return false;
    } else if (text[i] === "," && depth === 1) return true;
  }
  return false;
}

function renameLogs(text: string) {
  const step1 = text.replace(/\blog\s*\(/g, (match, offset: number, full: string) => {
    const open = offset + match.length - 1;
    return hasTopLevelComma(full, open) ? match : "log10(";
  });
  return step1.replace(/\bln\s*\(/g, "log(");
}

// Accepts "x^2", "y = x^2", "f(x) = x^2" or LaTeX like "y=\frac{x^2}{4}" and
// returns an expression string mathjs can parse.
function normalizeEquation(raw: string) {
  let text = isLatexLike(raw) ? latexToMathjs(raw) : raw;

  text = text
    .replace(/π/g, " pi ")
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*([a-zA-Z0-9.]+)/g, "sqrt($1)")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/\barc(sin|cos|tan)\b/g, "a$1");

  text = text.trim().replace(/^\s*[a-zA-Z]\s*(\([a-zA-Z]\))?\s*=\s*/, "");
  return renameLogs(text);
}

const AUTO_PAREN_FUNCTIONS = [
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "sqrt",
  "cbrt",
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "log",
  "ln",
  "abs",
  "exp",
];

// Returns the function name the text ends with, unless it's a LaTeX command
// (\sin) — those shouldn't get automatic parentheses.
function functionNameAtEnd(text: string) {
  const match = text.match(/(\\?)([a-zA-Z]+)$/);
  if (!match || match[1]) return null;

  const word = match[2].toLowerCase();
  return AUTO_PAREN_FUNCTIONS.includes(word) ? word : null;
}

// Brackets that get automatically paired while typing.
const PAIRS: Record<string, string> = { "(": ")", "{": "}" };
const CLOSERS = new Set(Object.values(PAIRS));

// ------------------------------------------------------------------
// SPEECH-TO-TEXT: turn spoken math into equation text
// ------------------------------------------------------------------
//
// Pipeline:
//   1. lowercase + phrase replacements ("sign of" -> sin, "squared" -> ^2 ...)
//   2. tokenize
//   3. number words -> digits ("twenty five" -> 25, "three point five" -> 3.5)
//   4. small recursive parser that places function parentheses and implicit
//      multiplication sensibly
//
// Conventions: a function applies to the next "term", so
//   "sine x plus 1"           -> sin(x)+1
//   "sine of 2 x"             -> sin(2*x)
//   "sine of x over 2"        -> sin(x/2)
//   "sine of open paren x plus 1 close paren" -> sin(x+1)

const ORDINALS = new Map<string, number>([
  ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
  ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10],
]);

const SPOKEN_PHRASES: [RegExp, string | ((...args: string[]) => string)][] = [
  // symbols the recognizer sometimes emits
  [/²/g, " ^2 "],
  [/³/g, " ^3 "],
  [/×/g, " * "],
  [/÷/g, " / "],
  [/[−–]/g, " - "],
  [/π/g, " pi "],
  [/√/g, " sqrt "],

  // powers
  [/\b(?:raised\s+)?to\s+the\s+power\s+of\b/g, " ^ "],
  [/\b(?:raised\s+)?to\s+the\s+(\d+)(?:st|nd|rd|th)(?:\s+power)?\b/g, (_m, n) => ` ^${n} `],
  [
    /\b(?:raised\s+)?to\s+the\s+(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+power)?\b/g,
    (_m, word) => ` ^${ORDINALS.get(word)} `,
  ],
  [/\b(?:raised\s+)?to\s+the\s+(?:negative|minus)\b/g, " ^ - "],
  [/\b(?:raised\s+)?to\s+the\b/g, " ^ "],
  [/\braised\s+to\b/g, " ^ "],
  [/\bpower\s+of\b/g, " ^ "],
  [/\bsquared\b/g, " ^2 "],
  [/\bcubed\b/g, " ^3 "],

  // roots, absolute value, logs
  [/\b(?:square\s+root)\b/g, " sqrt "],
  [/\b(?:cube\s+root)\b/g, " cbrt "],
  [/\b(?:absolute\s+value|magnitude|modulus)\b/g, " abs "],
  [/\bnatural\s+log(?:arithm)?\b/g, " ln "],
  [/\bl\s+n\b/g, " ln "],
  [/\blog(?:arithm)?(?:\s+base\s+(?:10|ten))?\b/g, " log "],

  // trig: inverse / hyperbolic first, then co-functions BEFORE plain ones
  // (so "co sine" is not split into "co" + "sine"). Includes common
  // mis-hearings such as "sign" for "sine" and "cosign" for "cosine".
  [/\b(?:arc|inverse|anti)[\s-]*(?:sin|sine|sines|sign|signs)\b/g, " asin "],
  [/\b(?:arc|inverse|anti)[\s-]*(?:cos|cosine|cosines|cosign|cosigns|co[\s-]+sine|co[\s-]+sign)\b/g, " acos "],
  [/\b(?:arc|inverse|anti)[\s-]*(?:tan|tangent|tangents)\b/g, " atan "],
  [/\bhyperbolic[\s-]*(?:sin|sine|sign)\b/g, " sinh "],
  [/\bhyperbolic[\s-]*(?:cos|cosine|cosign)\b/g, " cosh "],
  [/\bhyperbolic[\s-]*(?:tan|tangent)\b/g, " tanh "],
  [/\b(?:cosecant|cosecants|co[\s-]*secant|cosec|csc|c\s+s\s+c)\b/g, " csc "],
  [/\b(?:cotangent|cotangents|co[\s-]*tangent|cot)\b/g, " cot "],
  [/\b(?:cos|cosine|cosines|cosign|cosigns|co[\s-]+sine|co[\s-]+sign|kosine|cozine|coz)\b/g, " cos "],
  [/\b(?:sin|sine|sines|sign|signs|sinc)\b/g, " sin "],
  [/\b(?:tan|tans|tangent|tangents)\b/g, " tan "],
  [/\b(?:sec|secant|secants)\b/g, " sec "],

  // variables / constants the recognizer tends to mangle
  [/\bex\b/g, " x "],
  [/\beggs?\b/g, " x "],
  [/\bwhy\b/g, " y "],
  [/\bpie\b/g, " pi "],

  // operators
  [/\b(?:multiplied\s+by|multiply\s+by|times)\b/g, " * "],
  [/\bdivided\s+(?:by|into)\b/g, " / "],
  [/\bover\b/g, " / "],
  [/\b(?:plus|added\s+to)\b/g, " + "],
  [/\b(?:minus|subtract(?:ed)?|take\s+away|negative)\b/g, " - "],
  [/\b(?:is\s+equal\s+to|equals?(?:\s+to)?)\b/g, " = "],
  [/\bcomma\b/g, " , "],

  // grouping
  [/\b(?:open|left|begin)\s+(?:parenthesis|parentheses|paren|brackets?)\b/g, " ( "],
  [/\b(?:close|right|end)\s+(?:parenthesis|parentheses|paren|brackets?)\b/g, " ) "],
];

const NUMBER_WORDS = new Map<string, number>([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14],
  ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18],
  ["nineteen", 19],
]);
const TENS_WORDS = new Map<string, number>([
  ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50],
  ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90],
]);

// Words that sound like numbers, only converted when they sit in a math spot
// ("to x" -> 2x, "plus for" -> +4).
const NUMBER_HOMOPHONES = new Map<string, string>([
  ["to", "2"], ["too", "2"], ["for", "4"], ["fore", "4"], ["won", "1"], ["ate", "8"],
]);

// Filler words that carry no math meaning.
const IGNORED_WORDS = new Set(["of", "the", "and", "a", "an", "um", "uh", "then", "is", "quantity"]);

const FUNCTION_TOKENS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot",
  "asin", "acos", "atan", "sinh", "cosh", "tanh",
  "sqrt", "cbrt", "log", "ln", "abs", "exp",
]);
const OPERATOR_TOKENS = new Set(["+", "-", "*", "/", "=", ","]);
const LITERAL_POWER = /^\^\d+$/;

const isNumberTok = (t?: string) => !!t && /^\d+(\.\d+)?$/.test(t);
const isOperandStart = (t?: string) =>
  !!t &&
  (isNumberTok(t) ||
    t === "x" ||
    t === "y" ||
    t === "pi" ||
    t === "e" ||
    t === "(" ||
    FUNCTION_TOKENS.has(t));

function digitOfWord(t?: string): string | null {
  if (t === undefined) return null;
  const n = NUMBER_WORDS.get(t);
  if (n !== undefined && n < 10) return String(n);
  return /^\d$/.test(t) ? t : null;
}

function isNumberWord(t?: string) {
  return (
    t !== undefined &&
    (NUMBER_WORDS.has(t) || TENS_WORDS.has(t) || t === "hundred" || t === "thousand")
  );
}

// Whether number word `w` can continue a number that currently ends in `prev`
// ("twenty" + "five" yes, "two" + "three" no -> two separate numbers).
function canContinueNumber(prev: string, w: string) {
  if (w === "hundred" || w === "thousand") {
    return prev !== "hundred" && prev !== "thousand" ? true : w === "thousand" && prev === "hundred";
  }
  if (prev === "hundred" || prev === "thousand") return true;
  if (TENS_WORDS.has(prev)) {
    const n = NUMBER_WORDS.get(w);
    return n !== undefined && n >= 1 && n <= 9;
  }
  return false; // after ones/teens, only hundred/thousand may follow
}

function collapseNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    let value: string | null = null;

    if (isNumberWord(t)) {
      let total = 0;
      let current = 0;
      let prev = "";
      while (i < tokens.length && isNumberWord(tokens[i])) {
        const w = tokens[i];
        if (prev && !canContinueNumber(prev, w)) break;
        if (w === "hundred") current = (current || 1) * 100;
        else if (w === "thousand") {
          total += (current || 1) * 1000;
          current = 0;
        } else current += NUMBER_WORDS.get(w) ?? TENS_WORDS.get(w) ?? 0;
        prev = w;
        i++;
      }
      value = String(total + current);
    } else if (/^\d+$/.test(t)) {
      value = t;
      i++;
    }

    if (value !== null) {
      if (tokens[i] === "point") {
        let j = i + 1;
        let decimals = "";
        while (j < tokens.length) {
          const d = digitOfWord(tokens[j]);
          if (d === null) break;
          decimals += d;
          j++;
        }
        if (decimals) {
          value += "." + decimals;
          i = j;
        }
      }
      out.push(value);
      continue;
    }

    out.push(t);
    i++;
  }

  return out;
}

function fixNumberHomophones(tokens: string[]): string[] {
  return tokens.map((t, i) => {
    const digit = NUMBER_HOMOPHONES.get(t);
    if (!digit) return t;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const afterOperator =
      prev !== undefined && (OPERATOR_TOKENS.has(prev) || prev === "(" || prev === "^");
    return afterOperator || isOperandStart(next) ? digit : t;
  });
}

type Parsed = { text: string; next: number };

function parseGroup(tokens: string[], i: number): Parsed {
  const inner = parseSequence(tokens, i + 1, "paren");
  return { text: `(${inner.text})`, next: inner.next };
}

// A single operand: number, variable, constant, parenthesized group, or a
// function applied to its argument.
function parseAtom(tokens: string[], i: number): Parsed {
  const t = tokens[i];
  if (t === "(") return parseGroup(tokens, i);

  if (FUNCTION_TOKENS.has(t)) {
    let j = i + 1;
    let power = "";
    if (j < tokens.length && LITERAL_POWER.test(tokens[j])) {
      power = tokens[j]; // "sine squared x"
      j++;
    }

    let call: string;
    if (tokens[j] === "(") {
      const group = parseGroup(tokens, j);
      call = `${t}${group.text}`;
      j = group.next;
    } else {
      const arg = parseSequence(tokens, j, "arg");
      call = `${t}(${arg.text})`;
      j = arg.next;
    }
    return { text: call + power, next: j };
  }

  return { text: t, next: i + 1 };
}

// Exponent after "to the" / "to the power of": a unary minus followed by a
// run of operands, so "e to the 2 x" means e^(2x) and "e to the negative x"
// means e^(-x).
function parseExponent(tokens: string[], i: number): Parsed {
  let j = i + 1;
  let negative = false;
  if (tokens[j] === "-") {
    negative = true;
    j++;
  } else if (tokens[j] === "+") j++;

  let text = "";
  let hasOperand = false;
  while (j < tokens.length && isOperandStart(tokens[j])) {
    const atom = parseAtom(tokens, j);
    text += (hasOperand ? "*" : "") + atom.text;
    hasOperand = true;
    j = atom.next;
  }

  if (!text) return { text: "", next: j };
  if (negative) return { text: `^(-${text})`, next: j };
  return { text: /[*+\-/]/.test(text) ? `^(${text})` : `^${text}`, next: j };
}

function parseSequence(
  tokens: string[],
  start: number,
  mode: "top" | "paren" | "arg"
): Parsed {
  let out = "";
  let i = start;
  let prevOperand = false;

  while (i < tokens.length) {
    const t = tokens[i];

    if (t === ")") {
      if (mode === "paren") return { text: out, next: i + 1 };
      if (mode === "arg") break;
      i++; // stray ")"
      continue;
    }

    if (mode === "arg") {
      // A function argument ends at a binary + / - / = / , or a new function:
      // "sine x plus 1" -> sin(x)+1, "sine x cosine x" -> sin(x)*cos(x)
      if (t === "+" || t === "=" || t === ",") break;
      if (t === "-" && prevOperand) break;
      if (prevOperand && FUNCTION_TOKENS.has(t)) break;
    }

    if (isOperandStart(t)) {
      const atom = parseAtom(tokens, i);
      out += (prevOperand ? "*" : "") + atom.text;
      prevOperand = true;
      i = atom.next;
      continue;
    }

    if (t === "^") {
      const exp = parseExponent(tokens, i);
      out += exp.text;
      i = exp.next;
      continue;
    }

    if (LITERAL_POWER.test(t)) {
      if (prevOperand) out += t;
      i++;
      continue;
    }

    if (OPERATOR_TOKENS.has(t)) {
      out += t;
      prevOperand = false;
      i++;
      continue;
    }

    i++; // unknown word: skip it
  }

  return { text: out, next: i };
}

function spokenMathToEquation(spoken: string) {
  let text = ` ${spoken.toLowerCase()} `;

  for (const [pattern, replacement] of SPOKEN_PHRASES) {
    text = text.replace(pattern, replacement as any);
  }

  let tokens = text.match(/\d+(?:\.\d+)?|\^\d+|[a-z]+|[+\-*/^=(),]/g) ?? [];
  tokens = collapseNumberWords(tokens);
  tokens = fixNumberHomophones(tokens);
  tokens = tokens.filter((t) => !IGNORED_WORDS.has(t));

  const { text: expression } = parseSequence(tokens, 0, "top");
  return expression.replace(/^y=/, "");
}

// Hints that bias the recognizer toward math vocabulary (helps with
// "sine" vs "sign", etc.).
const SPEECH_CONTEXTUAL_STRINGS = [
  "sine", "cosine", "tangent", "secant", "cosecant", "cotangent",
  "arc sine", "arc cosine", "arc tangent",
  "square root", "cube root", "absolute value", "natural log",
  "x squared", "x cubed", "pi", "e to the x", "open parenthesis",
  "close parenthesis", "divided by", "times", "plus", "minus",
];

// ------------------------------------------------------------------
// GRAPH DESCRIPTION: local heuristic analysis, with an optional call
// out to a backend AI endpoint (per the team's planned FastAPI + OpenAI
// architecture) if one is configured.
// ------------------------------------------------------------------

// Set this to your backend's URL to get AI-written descriptions instead
// of the local heuristic one below, e.g. "https://your-api.example.com/describe".
const AI_DESCRIBE_ENDPOINT = "";

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function guessShape(equationRaw: string) {
  const lower = equationRaw.toLowerCase().replace(/\s+/g, "");
  if (/sin|cos|tan/.test(lower)) return "a periodic, wave-like curve";
  if (/sqrt/.test(lower)) return "a square-root curve";
  if (/x\^3|x\*\*3/.test(lower)) return "an S-shaped cubic curve";
  if (/x\^2|x\*\*2/.test(lower)) return "a parabola";
  if (/\/x|x\^-1|x\*\*-1/.test(lower))
    return "a curve with an asymptote, similar to a hyperbola";
  if (/\^|log|ln|exp/.test(lower)) return "a curved line";
  return "a straight line";
}

function analyzeCurve(
  evaluate: (scope: { x: number }) => number,
  xMin: number,
  xMax: number
) {
  const N = 300;
  let prevY: number | null = null;
  let prevX = xMin;

  const roots: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  let minAtX = xMin;
  let maxAtX = xMin;
  let gaps = 0;
  let sampledCount = 0;

  for (let i = 0; i <= N; i++) {
    const gx = xMin + (i / N) * (xMax - xMin);
    let gy: number;
    try {
      gy = evaluate({ x: gx });
    } catch {
      gy = NaN;
    }

    if (typeof gy === "number" && isFinite(gy)) {
      sampledCount++;
      if (gy < minY) {
        minY = gy;
        minAtX = gx;
      }
      if (gy > maxY) {
        maxY = gy;
        maxAtX = gx;
      }
      if (
        prevY !== null &&
        isFinite(prevY) &&
        prevY !== 0 &&
        Math.sign(prevY) !== Math.sign(gy)
      ) {
        roots.push((prevX + gx) / 2);
      }
    } else if (prevY !== null && isFinite(prevY)) {
      gaps++;
    }

    prevY = gy;
    prevX = gx;
  }

  let yIntercept: number | null = null;
  try {
    const y0 = evaluate({ x: 0 });
    if (typeof y0 === "number" && isFinite(y0)) yIntercept = y0;
  } catch {
    // out of domain at x = 0, leave yIntercept null
  }

  return { roots, minY, maxY, minAtX, maxAtX, yIntercept, gaps, sampledCount };
}

// Short, non-redundant description: what it looks like, where it crosses the
// axes, and its turning points. The origin is mentioned once, not three times.
function describeCurveLocally(
  equationRaw: string,
  evaluate: (scope: { x: number }) => number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
) {
  const { roots, minY, maxY, minAtX, maxAtX, yIntercept, gaps, sampledCount } =
    analyzeCurve(evaluate, xMin, xMax);

  if (sampledCount === 0) {
    return "Nothing to show in this view. Check the equation.";
  }

  if (isFinite(minY) && isFinite(maxY) && maxY - minY < 0.05) {
    return `A horizontal line at ${round1(minY)}.`;
  }

  const shape = guessShape(equationRaw);
  const parts: string[] = [`${shape[0].toUpperCase()}${shape.slice(1)}.`];

  const nearOrigin = (x: number, y: number) => Math.abs(x) < 0.25 && Math.abs(y) < 0.25;
  const place = (x: number, y: number) =>
    nearOrigin(x, y) ? "the origin" : `x ${round1(x)}, y ${round1(y)}`;

  const periodic = roots.length > 4;
  const margin = (xMax - xMin) * 0.04;
  const interior = (x: number) => x > xMin + margin && x < xMax - margin;

  let originCovered = false;
  const extremes: string[] = [];

  if (periodic) {
    extremes.push(`Repeats, ranging from ${round1(minY)} to ${round1(maxY)}.`);
  } else if (gaps === 0) {
    // Only report real turning points, not values at the edge of the view.
    if (interior(minAtX)) {
      extremes.push(`Lowest point at ${place(minAtX, minY)}.`);
      if (nearOrigin(minAtX, minY)) originCovered = true;
    }
    if (interior(maxAtX)) {
      extremes.push(`Highest point at ${place(maxAtX, maxY)}.`);
      if (nearOrigin(maxAtX, maxY)) originCovered = true;
    }
  }

  const intercepts: string[] = [];
  let xs = periodic ? [] : roots;
  if (originCovered) xs = xs.filter((r) => Math.abs(r) >= 0.25);

  if (yIntercept !== null && yIntercept >= yMin && yIntercept <= yMax) {
    if (nearOrigin(0, yIntercept)) {
      if (!originCovered) {
        intercepts.push("Passes through the origin.");
        originCovered = true;
      }
      xs = xs.filter((r) => Math.abs(r) >= 0.25);
    } else {
      intercepts.push(`Crosses the y axis at ${round1(yIntercept)}.`);
    }
  }

  if (xs.length > 0) {
    intercepts.push(`Crosses the x axis at ${xs.map((r) => round1(r)).join(", ")}.`);
  }

  parts.push(...intercepts, ...extremes);

  if (gaps > 0) {
    parts.push("It has a break, such as an asymptote.");
  }

  return parts.join(" ");
}

async function describeCurveWithAI(
  equationRaw: string,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): Promise<string | null> {
  if (!AI_DESCRIBE_ENDPOINT) return null;
  try {
    const res = await fetch(AI_DESCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equation: equationRaw, xMin, xMax, yMin, yMax }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.description === "string" ? data.description : null;
  } catch {
    return null; // silently fall back to the local description
  }
}

// ------------------------------------------------------------------
// MAIN SCREEN
// ------------------------------------------------------------------

export default function Index() {
  const [mode, setMode] = useState<"shape" | "graph">("shape");

  // Shape state
  const [shapeInput, setShapeInput] = useState("triangle");
  const [shape, setShape] = useState<Point[]>(TRIANGLE);
  const [shapeError, setShapeError] = useState<string | null>(null);

  const [debugDist, setDebugDist] = useState<number | null>(null);

  // Equation input state
  const [equationInput, setEquationInput] = useState("x^2 / 4");
  const [equationSelection, setEquationSelection] = useState({
    start: 8,
    end: 8,
  });
  const equationSelectionRef = useRef(equationSelection);
  const previousEquationRef = useRef(equationInput);
  const [equationError, setEquationError] = useState<string | null>(null);
  const [equationVersion, setEquationVersion] = useState(0);

  // Fixed graph window (zoom was removed).
  const xMin = HOME_X_MIN;
  const xMax = HOME_X_MAX;
  const yMin = HOME_Y_MIN;
  const yMax = HOME_Y_MAX;
  const compiledRef = useRef<{ evaluate: (scope: any) => number } | null>(
    null
  );

  // Measured size of the drawing area (needed to map math units -> pixels)
  const [graphLayout, setGraphLayout] = useState({ width: 0, height: 0 });

  // The curve, already converted to screen-pixel points, split into
  // separate strokes wherever the function has a gap or a big jump
  // (e.g. an asymptote).
  const [strokes, setStrokes] = useState<Point[][]>([]);

  const displayedShape = fitShapeToCanvas(
    shape,
    graphLayout.width,
    graphLayout.height
  );
  const corners = findCorners(displayedShape);

  // --- Speech (text-to-speech narration) ---
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const speechEnabledRef = useRef(speechEnabled);
  useEffect(() => {
    speechEnabledRef.current = speechEnabled;
    if (!speechEnabled) Speech.stop();
  }, [speechEnabled]);

  const lastDescriptionRef = useRef("");

  // The newest message always wins, so announcements never pile up.
  const speak = (text: string) => {
    if (!speechEnabledRef.current || !text) return;
    Speech.stop();
    Speech.speak(text, { rate: 0.95, pitch: 1.0 });
  };

  // --- Speech (speech-to-text equation input) ---
  const [isListening, setIsListening] = useState(false);

  function applyShapePrompt(prompt: string) {
    const nextShape = shapeFromPrompt(prompt);
    if (!nextShape) {
      setShapeError("Try a named shape, regular polygon with sides, or 5-gon.");
      speak("Sorry, I couldn't make that shape.");
      return;
    }
    setShape(nextShape);
    setShapeError(null);
    const cornerCount = findCorners(nextShape).length;
    const summary = cornerCount === 0 ? "No corners." : `${cornerCount} corners.`;
    lastDescriptionRef.current = summary;
    // The person typed the shape name, so just confirm the useful part.
    speak(summary);
  }

  const xPixelsPerUnit =
    graphLayout.width > 0 ? graphLayout.width / (xMax - xMin) : 0;
  const yPixelsPerUnit =
    graphLayout.height > 0 ? graphLayout.height / (yMax - yMin) : 0;

  const toScreen = (gx: number, gy: number): Point => ({
    x: (gx - xMin) * xPixelsPerUnit,
    y: (yMax - gy) * yPixelsPerUnit,
  });

  const setEquationCursor = (start: number, end = start) => {
    const next = { start, end };
    equationSelectionRef.current = next;
    setEquationSelection(next);
  };

  const handleEquationSelectionChange = (start: number, end: number) => {
    const next = { start, end };
    equationSelectionRef.current = next;
    setEquationSelection(next);
  };

  // Desmos-like editing: automatically pair ( ) and { }, remove the pair when
  // Backspace deletes the opener, skip a duplicate closer, and turn common
  // function names into function calls (but not LaTeX commands like \sin).
  const handleEquationChange = (nextText: string) => {
    const previous = previousEquationRef.current;
    const oldSelection = equationSelectionRef.current;
    const cursor = oldSelection.start;

    // A normal one-character insertion at the cursor.
    if (
      nextText.length === previous.length + 1 &&
      oldSelection.start === oldSelection.end
    ) {
      const inserted = nextText[cursor];
      const closer = PAIRS[inserted];

      if (closer) {
        const withClose =
          nextText[cursor + 1] === closer
            ? nextText
            : nextText.slice(0, cursor + 1) + closer + nextText.slice(cursor + 1);

        setEquationInput(withClose);
        previousEquationRef.current = withClose;
        setEquationCursor(cursor + 1);
        return;
      }

      // Typing a closer right before an existing auto-inserted one just
      // moves past it.
      if (CLOSERS.has(inserted) && previous[cursor] === inserted) {
        setEquationInput(previous);
        previousEquationRef.current = previous;
        setEquationCursor(cursor + 1);
        return;
      }
    }

    // If Backspace deleted an opener, remove its matching auto-inserted closer.
    if (
      nextText.length === previous.length - 1 &&
      oldSelection.start === oldSelection.end &&
      cursor > 0
    ) {
      const opener = previous[cursor - 1];
      if (opener && PAIRS[opener] && previous[cursor] === PAIRS[opener]) {
        const paired = nextText.slice(0, cursor - 1) + nextText.slice(cursor);
        setEquationInput(paired);
        previousEquationRef.current = paired;
        setEquationCursor(cursor - 1);
        return;
      }
    }

    setEquationInput(nextText);
    previousEquationRef.current = nextText;

    const fn = functionNameAtEnd(nextText);
    if (
      fn &&
      nextText.endsWith(fn) &&
      previous.length < nextText.length &&
      oldSelection.start === oldSelection.end &&
      oldSelection.start === previous.length &&
      !previous.endsWith(fn)
    ) {
      const after = nextText + "()";
      setEquationInput(after);
      previousEquationRef.current = after;
      setEquationCursor(after.length - 1);
      return;
    }

    // Preserve the cursor position for normal edits, including edits in the
    // middle of the equation.
    const delta = nextText.length - previous.length;
    const nextCursor = Math.max(
      0,
      Math.min(nextText.length, oldSelection.start + delta)
    );
    setEquationCursor(nextCursor);
  };

  const handlePlotEquation = async () => {
    try {
      const cleaned = normalizeEquation(equationInput);
      const node = parse(cleaned);
      const compiled = node.compile();
      compiledRef.current = compiled;
      setEquationError(null);
      setEquationVersion((v) => v + 1); // triggers resample below

      const evaluate = (scope: { x: number }) => compiled.evaluate(scope);
      const aiDescription = await describeCurveWithAI(
        cleaned,
        xMin,
        xMax,
        yMin,
        yMax
      );
      const description =
        aiDescription ??
        describeCurveLocally(cleaned, evaluate, xMin, xMax, yMin, yMax);

      lastDescriptionRef.current = description;
      speak(description);
    } catch {
      compiledRef.current = null;
      setEquationError("Couldn't understand that equation.");
      setStrokes([]);
      speak("Sorry, I couldn't understand that equation.");
    }
  };

  // Resample the curve whenever the equation changes OR the drawing
  // area is measured or resized.
  useEffect(() => {
    if (!compiledRef.current || graphLayout.width === 0) {
      return;
    }

    const compiled = compiledRef.current;
    const newStrokes = sampleFunctionToStrokes(
      (scope) => compiled.evaluate(scope),
      xMin,
      xMax,
      toScreen,
      SAMPLE_COUNT,
      graphLayout.height * 1.5
    );

    setStrokes(newStrokes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equationVersion, graphLayout.width, graphLayout.height]);

  // Announce each mode name only the first time it is entered.
  const announcedModesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (announcedModesRef.current.has(mode) || !speechEnabledRef.current) return;
    announcedModesRef.current.add(mode);
    speak(mode === "graph" ? "Graph mode" : "Shape mode");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ------------------------------------------------------------------
  // SPEECH-TO-TEXT EVENTS
  // Requires a custom dev client build — this native module is not
  // available in the plain Expo Go app.
  // ------------------------------------------------------------------

  useSpeechRecognitionEvent("result", (event: any) => {
    const transcript = event.results?.[0]?.transcript ?? "";
    if (transcript) {
      const converted = spokenMathToEquation(transcript);
      setEquationInput(converted);
      previousEquationRef.current = converted;
      setEquationCursor(converted.length);
    }
  });

  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
  });

  useSpeechRecognitionEvent("error", () => {
    setIsListening(false);
    setEquationError("Couldn't hear that clearly — try again.");
  });

  const startListening = async () => {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setEquationError("Microphone permission is needed for speech input.");
      return;
    }
    Speech.stop(); // don't let narration leak into the microphone
    setEquationError(null);
    setIsListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: false,
      continuous: false,
      addsPunctuation: false,
      contextualStrings: SPEECH_CONTEXTUAL_STRINGS,
    });
  };

  const stopListening = () => {
    ExpoSpeechRecognitionModule.stop();
  };

  // ------------------------------------------------------------------
  // REFS READ BY THE (create-once) PanResponder HANDLERS
  // ------------------------------------------------------------------

  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const strokesRef = useRef(strokes);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const graphLayoutRef = useRef(graphLayout);
  useEffect(() => {
    graphLayoutRef.current = graphLayout;
  }, [graphLayout]);

  // ------------------------------------------------------------------
  // HAPTICS + TONE AUDIO (shared by both modes — just needs a distance in pixels)
  // ------------------------------------------------------------------

  const lastPulseTime = useRef(0);
  const nextPulseDelay = useRef(9999);
  const currentDistanceRef = useRef(Infinity);
  const hapticIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentTimeRef = useRef(0);
  const shapeRef = useRef<Point[]>(displayedShape);
  const cornersRef = useRef<Point[]>(corners);
  const activeVertexHitsRef = useRef<boolean[]>([]);
  const audioRef = useRef<{
    context: any;
    master: any;
    tones: { oscillator: any; gain: any }[];
  } | null>(null);
  const nativeAudioRef = useRef<ReturnType<typeof createAudioPlayer>[] | null>(
    null
  );

  useEffect(() => {
    shapeRef.current = displayedShape;
    cornersRef.current = findCorners(displayedShape);
  }, [displayedShape]);

  const setGain = (gainNode: any, value: number) => {
    const context = audioRef.current?.context;
    if (!gainNode || !context) return;

    const safeValue = Math.max(0, Math.min(1, value));
    gainNode.gain.cancelScheduledValues(context.currentTime);
    gainNode.gain.setTargetAtTime(safeValue, context.currentTime, 0.025);
  };

  const startAudio = () => {
    if (Platform.OS !== "web") {
      if (nativeAudioRef.current) return;

      nativeAudioRef.current = TONE_SOURCES.map((source) => {
        const player = createAudioPlayer(source);
        player.loop = true;
        player.volume = 0;
        player.play();
        return player;
      });
      return;
    }

    if (audioRef.current) return;

    const AudioContextClass =
      (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = 0.22;
    master.connect(context.destination);

    const tones = [
      BASE_TONE_FREQUENCY,
      LINE_TONE_FREQUENCY,
      VERTEX_TONE_FREQUENCY,
    ].map((frequency) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start();
      return { oscillator, gain };
    });

    audioRef.current = { context, master, tones };
    context.resume?.();
  };

  const updateAudio = (distance: number, isOnVertex: boolean) => {
    startAudio();

    const finiteDistance = Number.isFinite(distance) ? distance : MAX_HAPTIC_DISTANCE;
    const closeness = 1 - Math.min(finiteDistance, MAX_HAPTIC_DISTANCE) / MAX_HAPTIC_DISTANCE;
    const baseGain = 0.04 + closeness * 0.18;
    const lineGain = finiteDistance <= LINE_CHORD_DISTANCE ? 0.13 + closeness * 0.12 : 0;
    const vertexGain = isOnVertex ? 0.12 + closeness * 0.1 : 0;

    if (Platform.OS !== "web") {
      const players = nativeAudioRef.current;
      if (!players) return;

      players[0].volume = baseGain;
      players[1].volume = lineGain;
      players[2].volume = vertexGain;
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    setGain(audio.tones[0].gain, baseGain);
    setGain(audio.tones[1].gain, lineGain);
    setGain(audio.tones[2].gain, vertexGain);
  };

  const stopAudio = () => {
    const nativePlayers = nativeAudioRef.current;
    if (nativePlayers) {
      nativePlayers.forEach((player) => {
        player.volume = 0;
        player.pause();
        player.remove();
      });
      nativeAudioRef.current = null;
    }

    const audio = audioRef.current;
    if (!audio) return;

    audio.tones.forEach(({ oscillator, gain }) => {
      setGain(gain, 0);
      try {
        oscillator.stop(audio.context.currentTime + 0.08);
      } catch {
        // Oscillators can only be stopped once.
      }
    });
    audioRef.current = null;
  };

  const triggerHapticIfDue = (distance: number, now: number) => {
    const MAX_DIST = MAX_HAPTIC_DISTANCE;

    if (distance >= MAX_DIST) {
      nextPulseDelay.current = 9999;
      return;
    }

    const minDelay = 40;
    const maxDelay = 400;
    const delay = minDelay + (distance / MAX_DIST) * (maxDelay - minDelay);
    nextPulseDelay.current = delay;

    if (now - lastPulseTime.current >= delay) {
      lastPulseTime.current = now;

      if (distance < 12) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  };

  // Soft haptic pulse the moment the finger enters a corner. Returns whether
  // the finger is currently on any corner so the vertex tone can be mixed in.
  // (No spoken "Corner": the haptic + tone already say it, and long-pressing
  // gives the nearest corner's distance and direction.)
  const triggerVertexHapticOnEntry = (
    x: number,
    y: number,
    distance: number
  ) => {
    if (modeRef.current !== "shape" || distance >= MAX_HAPTIC_DISTANCE) {
      activeVertexHitsRef.current = [];
      return false;
    }

    const previousHits = activeVertexHitsRef.current;
    const currentHits = cornersRef.current.map(
      (point) => Math.hypot(point.x - x, point.y - y) <= VERTEX_HITBOX_RADIUS
    );

    currentHits.forEach((inside, index) => {
      if (inside && !previousHits[index]) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
      }
    });
    activeVertexHitsRef.current = currentHits;
    return currentHits.some(Boolean);
  };

  const stopHapticPolling = () => {
    if (hapticIntervalRef.current !== null) {
      clearInterval(hapticIntervalRef.current);
      hapticIntervalRef.current = null;
    }
    currentDistanceRef.current = Infinity;
  };

  const startHapticPolling = () => {
    stopHapticPolling();
    hapticIntervalRef.current = setInterval(() => {
      currentTimeRef.current = Date.now();
      triggerHapticIfDue(currentDistanceRef.current, currentTimeRef.current);
    }, 40);
  };

  // ------------------------------------------------------------------
  // DWELL: holding still for 1 second announces the nearest corner
  // ------------------------------------------------------------------

  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellAnchorRef = useRef<Point | null>(null);
  const lastTouchRef = useRef<Point>({ x: 0, y: 0 });

  const clearDwell = () => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    dwellAnchorRef.current = null;
  };

  const announceNearestCorner = () => {
    dwellTimerRef.current = null;
    if (modeRef.current !== "shape") return;

    const cornerList = cornersRef.current;
    if (cornerList.length === 0) return;

    const { x, y } = lastTouchRef.current;
    let nearest = cornerList[0];
    let nearestDistance = Infinity;
    for (const corner of cornerList) {
      const d = Math.hypot(corner.x - x, corner.y - y);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = corner;
      }
    }

    if (nearestDistance <= ON_CORNER_PX) {
      speak("On a corner");
      return;
    }

    const pixels = Math.round(nearestDistance);
    const direction = directionWords(nearest.x - x, nearest.y - y);
    speak(`Nearest corner is ${pixels} ${pixels === 1 ? "pixel" : "pixels"} ${direction}`);
  };

  // Called on every touch position. Restarts the 1-second timer only when the
  // finger has actually moved (small jitter is ignored), and never re-fires
  // until the finger moves again.
  const trackDwell = (x: number, y: number) => {
    lastTouchRef.current = { x, y };
    const anchor = dwellAnchorRef.current;
    if (anchor && Math.hypot(x - anchor.x, y - anchor.y) <= DWELL_JITTER_PX) {
      return;
    }
    if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
    dwellAnchorRef.current = { x, y };
    dwellTimerRef.current = setTimeout(announceNearestCorner, DWELL_MS);
  };

  useEffect(
    () => () => {
      stopHapticPolling();
      stopAudio();
      clearDwell();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Edge-triggers for the spoken axis cues, so we announce once on entry
  // rather than on every touch-move frame. The "near" flag only resets once
  // the finger is clearly away (hysteresis), so jitter near an axis is quiet.
  const wasNearXAxisRef = useRef(false);
  const wasNearYAxisRef = useRef(false);

  const resetTouchState = () => {
    stopHapticPolling();
    stopAudio();
    clearDwell();
    activeVertexHitsRef.current = [];
    wasNearXAxisRef.current = false;
    wasNearYAxisRef.current = false;
    setDebugDist(null);
  };

  // PanResponder is intentionally created once so it keeps one responder identity.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        activeVertexHitsRef.current = [];
        currentDistanceRef.current =
          modeRef.current === "shape"
            ? distanceToShape(locationX, locationY, shapeRef.current)
            : distanceToStrokes(locationX, locationY, strokesRef.current);
        const isOnVertex = triggerVertexHapticOnEntry(
          locationX,
          locationY,
          currentDistanceRef.current
        );
        updateAudio(currentDistanceRef.current, isOnVertex);
        startHapticPolling();
        trackDwell(locationX, locationY);
      },

      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;

        const distance =
          modeRef.current === "shape"
            ? distanceToShape(locationX, locationY, shapeRef.current)
            : distanceToStrokes(locationX, locationY, strokesRef.current);

        currentDistanceRef.current = distance;
        const isOnVertex = triggerVertexHapticOnEntry(locationX, locationY, distance);
        updateAudio(distance, isOnVertex);
        setDebugDist(Number.isFinite(distance) ? Math.round(distance) : null);
        triggerHapticIfDue(distance, currentTimeRef.current);
        trackDwell(locationX, locationY);

        // Spoken axis cues (graph mode). The curve itself is not announced:
        // the tone and haptics already tell you when you're on it.
        if (modeRef.current === "graph" && speechEnabledRef.current) {
          const layout = graphLayoutRef.current;
          if (layout.width > 0 && layout.height > 0) {
            const xPxPerUnit = layout.width / (HOME_X_MAX - HOME_X_MIN);
            const yPxPerUnit = layout.height / (HOME_Y_MAX - HOME_Y_MIN);
            const xAxisScreenY = HOME_Y_MAX * yPxPerUnit;
            const yAxisScreenX = -HOME_X_MIN * xPxPerUnit;

            const dxAxis = Math.abs(locationY - xAxisScreenY);
            const dyAxis = Math.abs(locationX - yAxisScreenX);

            const nearX = dxAxis < 8;
            const nearY = dyAxis < 8;
            const enteringX = nearX && !wasNearXAxisRef.current;
            const enteringY = nearY && !wasNearYAxisRef.current;

            if (nearX) wasNearXAxisRef.current = true;
            else if (dxAxis > 16) wasNearXAxisRef.current = false;
            if (nearY) wasNearYAxisRef.current = true;
            else if (dyAxis > 16) wasNearYAxisRef.current = false;

            if (enteringX || enteringY) {
              if (nearX && nearY) speak("Origin");
              else speak(enteringX ? "x axis" : "y axis");
            }
          }
        }
      },

      onPanResponderRelease: resetTouchState,
      onPanResponderTerminate: resetTouchState,
    })
  ).current;

  return (
    <View style={styles.container}>
      {/* ---------------- Controls ---------------- */}
      <View style={styles.controls}>
        <View style={styles.modeRow}>
          <Pressable
            style={[styles.modeButton, mode === "shape" && styles.modeButtonActive]}
            onPress={() => setMode("shape")}
          >
            <Text style={styles.modeButtonText}>Shape</Text>
          </Pressable>
          <Pressable
            style={[styles.modeButton, mode === "graph" && styles.modeButtonActive]}
            onPress={() => setMode("graph")}
          >
            <Text style={styles.modeButtonText}>Graph</Text>
          </Pressable>
          <Pressable
            style={[styles.modeButton, speechEnabled && styles.modeButtonActive]}
            onPress={() => setSpeechEnabled((v) => !v)}
          >
            <Text style={styles.modeButtonText}>
              {speechEnabled ? "🔊 Speech On" : "🔇 Speech Off"}
            </Text>
          </Pressable>
        </View>

        {mode === "graph" && (
          <>
            <View style={styles.equationRow}>
              <TextInput
                style={styles.equationInput}
                value={equationInput}
                selection={equationSelection}
                onSelectionChange={(e) =>
                  handleEquationSelectionChange(
                    e.nativeEvent.selection.start,
                    e.nativeEvent.selection.end
                  )
                }
                onChangeText={handleEquationChange}
                onSubmitEditing={handlePlotEquation}
                placeholder="y = x^2, sin(x), or LaTeX: \frac{x^2}{4}"
                placeholderTextColor="#888"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                selectTextOnFocus={false}
              />
              <Pressable
                style={[styles.micButton, isListening && styles.micButtonActive]}
                onPress={isListening ? stopListening : startListening}
              >
                <Text style={styles.graphControlText}>{isListening ? "⏹" : "🎤"}</Text>
              </Pressable>
              <Pressable style={styles.plotButton} onPress={handlePlotEquation}>
                <Text style={styles.plotButtonText}>Plot</Text>
              </Pressable>
            </View>

            {isListening && <Text style={styles.listeningText}>Listening…</Text>}

            <View style={styles.graphControlsRow}>
              <Pressable
                style={styles.describeButton}
                onPress={() =>
                  speak(lastDescriptionRef.current || "Nothing is plotted yet.")
                }
              >
                <Text style={styles.graphControlText}>🔊 Describe</Text>
              </Pressable>
            </View>
          </>
        )}

        {equationError && <Text style={styles.errorText}>{equationError}</Text>}

        {mode === "shape" && (
          <>
            <View style={styles.shapeInputRow}>
              <TextInput
                style={styles.shapeInput}
                value={shapeInput}
                onChangeText={setShapeInput}
                onSubmitEditing={() => applyShapePrompt(shapeInput)}
                placeholder="e.g. pentagon or random quadrilateral"
                placeholderTextColor="#888"
                autoCapitalize="none"
                returnKeyType="done"
              />
              <Pressable
                style={styles.shapeActionButton}
                onPress={() => applyShapePrompt(shapeInput)}
              >
                <Text style={styles.shapeActionText}>Draw</Text>
              </Pressable>
            </View>
            {shapeError && <Text style={styles.errorText}>{shapeError}</Text>}
          </>
        )}
      </View>

      {/* ---------------- Drawing / touch area ---------------- */}
      <View
        style={styles.drawArea}
        {...panResponder.panHandlers}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setGraphLayout({ width, height });
        }}
      >
        {mode === "shape" && (
          <>
            {displayedShape.map((point, index) => (
              <TriangleEdge
                key={`edge-${index}`}
                a={point}
                b={displayedShape[(index + 1) % displayedShape.length]}
              />
            ))}
            {corners.map((point, index) => (
              <ShapeVertex key={`vertex-${index}`} point={point} />
            ))}
          </>
        )}

        {mode === "graph" && graphLayout.width > 0 && (
          <Svg
            style={StyleSheet.absoluteFill}
            width={graphLayout.width}
            height={graphLayout.height}
            pointerEvents="none"
          >
            {(() => {
              // Pick a "nice" grid step so tick marks stay readable.
              const niceStep = (pixelsPerUnit: number) => {
                if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) return 1;
                const targetUnits = GRID_MIN_SPACING_PX / pixelsPerUnit;
                const exponent = Math.floor(Math.log10(targetUnits));
                const base = targetUnits / Math.pow(10, exponent);
                const candidate =
                  base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
                return candidate * Math.pow(10, exponent);
              };

              const xStep = niceStep(xPixelsPerUnit);
              const yStep = niceStep(yPixelsPerUnit);

              const xAxisY = toScreen(0, 0).y;
              const yAxisX = toScreen(0, 0).x;

              const xStart = Math.ceil(xMin / xStep) * xStep;
              const yStart = Math.ceil(yMin / yStep) * yStep;

              const xTicks: number[] = [];
              for (let x = xStart; x <= xMax + xStep * 0.001; x += xStep) {
                xTicks.push(Number(x.toFixed(12)));
              }

              const yTicks: number[] = [];
              for (let y = yStart; y <= yMax + yStep * 0.001; y += yStep) {
                yTicks.push(Number(y.toFixed(12)));
              }

              const formatNumber = (n: number) => {
                if (Math.abs(n) < 1e-10) return "0";
                if (Math.abs(n) >= 1000 || Math.abs(n) < 0.01) {
                  return n.toExponential(0);
                }
                return Number(n.toFixed(6)).toString();
              };

              return (
                <>
                  {/* Light coordinate grid */}
                  {xTicks.map((x) => {
                    const sx = toScreen(x, 0).x;
                    return (
                      <Line
                        key={`grid-x-${x}`}
                        x1={sx}
                        y1={0}
                        x2={sx}
                        y2={graphLayout.height}
                        stroke="#333"
                        strokeWidth={0.6}
                      />
                    );
                  })}

                  {yTicks.map((y) => {
                    const sy = toScreen(0, y).y;
                    return (
                      <Line
                        key={`grid-y-${y}`}
                        x1={0}
                        y1={sy}
                        x2={graphLayout.width}
                        y2={sy}
                        stroke="#333"
                        strokeWidth={0.6}
                      />
                    );
                  })}

                  {/* Main axes */}
                  {yAxisX >= 0 && yAxisX <= graphLayout.width && (
                    <Line
                      x1={yAxisX}
                      y1={0}
                      x2={yAxisX}
                      y2={graphLayout.height}
                      stroke="#777"
                      strokeWidth={1.5}
                    />
                  )}

                  {xAxisY >= 0 && xAxisY <= graphLayout.height && (
                    <Line
                      x1={0}
                      y1={xAxisY}
                      x2={graphLayout.width}
                      y2={xAxisY}
                      stroke="#777"
                      strokeWidth={1.5}
                    />
                  )}

                  {/* Tick marks + numeric labels on the x-axis */}
                  {xTicks.map((x) => {
                    const sx = toScreen(x, 0).x;
                    if (sx < -20 || sx > graphLayout.width + 20) return null;

                    return (
                      <React.Fragment key={`x-tick-${x}`}>
                        <Line
                          x1={sx}
                          y1={xAxisY - 5}
                          x2={sx}
                          y2={xAxisY + 5}
                          stroke="#aaa"
                          strokeWidth={1.5}
                        />
                        {Math.abs(x) > 1e-10 && (
                          <SvgText
                            x={sx}
                            y={xAxisY + 18}
                            fill="#aaa"
                            fontSize="11"
                            textAnchor="middle"
                          >
                            {formatNumber(x)}
                          </SvgText>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {/* Tick marks + numeric labels on the y-axis */}
                  {yTicks.map((y) => {
                    const sy = toScreen(0, y).y;
                    if (sy < -20 || sy > graphLayout.height + 20) return null;

                    return (
                      <React.Fragment key={`y-tick-${y}`}>
                        <Line
                          x1={yAxisX - 5}
                          y1={sy}
                          x2={yAxisX + 5}
                          y2={sy}
                          stroke="#aaa"
                          strokeWidth={1.5}
                        />
                        {Math.abs(y) > 1e-10 && (
                          <SvgText
                            x={yAxisX - 8}
                            y={sy + 4}
                            fill="#aaa"
                            fontSize="11"
                            textAnchor="end"
                          >
                            {formatNumber(y)}
                          </SvgText>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {/* Origin label */}
                  {yAxisX >= 0 &&
                    yAxisX <= graphLayout.width &&
                    xAxisY >= 0 &&
                    xAxisY <= graphLayout.height && (
                      <SvgText
                        x={yAxisX + 7}
                        y={xAxisY + 16}
                        fill="#aaa"
                        fontSize="11"
                      >
                        0
                      </SvgText>
                    )}
                </>
              );
            })()}

            {/* curve, one Path per continuous stroke */}
            {strokes.map((stroke, idx) => (
              <Path
                key={idx}
                d={stroke
                  .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
                  .join(" ")}
                stroke="white"
                strokeWidth={4}
                fill="none"
              />
            ))}
          </Svg>
        )}

        {/* Debug information */}
        <Text style={styles.debugText}>
          {debugDist !== null
            ? `Distance: ${debugDist}px`
            : mode === "shape"
              ? "Touch and drag to feel the shape"
              : "Touch and drag to feel the curve"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111",
  },

  controls: {
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#111",
  },

  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 10,
  },

  modeButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#555",
  },

  modeButtonActive: {
    backgroundColor: "#3366cc",
    borderColor: "#3366cc",
  },

  modeButtonText: {
    color: "white",
    fontSize: 14,
  },

  equationRow: {
    flexDirection: "row",
    gap: 10,
  },

  equationInput: {
    flex: 1,
    color: "white",
    borderWidth: 1,
    borderColor: "#555",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },

  shapeInputRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },

  shapeInput: {
    flex: 1,
    color: "white",
    borderWidth: 1,
    borderColor: "#555",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },

  shapeActionButton: {
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 12,
    justifyContent: "center",
    backgroundColor: "#3366cc",
  },

  shapeActionText: {
    color: "white",
    fontSize: 14,
    fontWeight: "600",
  },

  micButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#555",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b1b1b",
  },

  micButtonActive: {
    backgroundColor: "#cc3333",
    borderColor: "#cc3333",
  },

  listeningText: {
    color: "#88ccff",
    fontSize: 12,
    marginTop: 4,
  },

  graphControlsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },

  describeButton: {
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#555",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b1b1b",
  },

  graphControlText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },

  plotButton: {
    backgroundColor: "#3366cc",
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },

  plotButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },

  errorText: {
    color: "#ff6b6b",
    marginTop: 6,
    fontSize: 13,
  },

  drawArea: {
    flex: 1,
    backgroundColor: "#111",
  },

  debugText: {
    position: "absolute",
    top: 10,
    left: 20,
    color: "white",
    fontSize: 14,
  },
});