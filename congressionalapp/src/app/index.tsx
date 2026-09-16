import React, { useEffect, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  PanResponder,
  Text,
  TextInput,
  Pressable,
} from "react-native";
import Svg, { Path, Line, Text as SvgText } from "react-native-svg";
import * as Haptics from "expo-haptics";
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

// ------------------------------------------------------------------
// TRIANGLE (SHAPE) MODE
// ------------------------------------------------------------------

const TRIANGLE = [
  { x: 100, y: 150 }, // top
  { x: 250, y: 500 }, // bottom left
  { x: 50, y: 500 }, // bottom right
];

function distanceToTriangle(px: number, py: number) {
  const edges = [
    [TRIANGLE[0], TRIANGLE[1]],
    [TRIANGLE[1], TRIANGLE[2]],
    [TRIANGLE[2], TRIANGLE[0]],
  ];

  return Math.min(
    ...edges.map(([a, b]) => distToSegment(px, py, a.x, a.y, b.x, b.y))
  );
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

// ------------------------------------------------------------------
// GRAPH (EQUATION) MODE
// ------------------------------------------------------------------

// Visible graph window, in math units, along x. Y is derived from this
// plus the pixel aspect ratio so a circle actually looks round.
const HOME_X_MIN = -10;
const HOME_X_MAX = 10;
const HOME_Y_MIN = -10;
const HOME_Y_MAX = 10;
const MIN_RANGE = 0.25;
const MAX_RANGE = 200;
const SAMPLE_COUNT = 600;
const GRID_MIN_SPACING_PX = 45;

// Strip a leading "y =", "f(x) =" etc, so people can type either
// "x^2" or "y = x^2" and get the same thing.
function normalizeEquation(raw: string) {
  return raw.trim().replace(/^\s*[a-zA-Z]\s*(\([a-zA-Z]\))?\s*=\s*/, "");
}

const AUTO_PAREN_FUNCTIONS = [
  "asin",
  "acos",
  "atan",
  "sqrt",
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

function functionNameAtEnd(text: string) {
  const match = text.match(/[a-zA-Z]+$/);
  if (!match) return null;

  const word = match[0].toLowerCase();
  return AUTO_PAREN_FUNCTIONS.includes(word) ? word : null;
}

export default function Index() {
  const [mode, setMode] = useState<"shape" | "graph">("shape");

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

  // Graph viewport. X and Y ranges both change during zoom, like a
  // coordinate-plane graphing calculator.
  const [xMin, setXMin] = useState(HOME_X_MIN);
  const [xMax, setXMax] = useState(HOME_X_MAX);
  const [yMin, setYMin] = useState(HOME_Y_MIN);
  const [yMax, setYMax] = useState(HOME_Y_MAX);
  const compiledRef = useRef<{ evaluate: (scope: any) => number } | null>(
    null
  );

  // Measured size of the drawing area (needed to map math units -> pixels)
  const [graphLayout, setGraphLayout] = useState({ width: 0, height: 0 });

  // The curve, already converted to screen-pixel points, split into
  // separate strokes wherever the function has a gap or a big jump
  // (e.g. an asymptote).
  const [strokes, setStrokes] = useState<Point[][]>([]);

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

  // Desmos-like editing: automatically pair parentheses, close paired
  // parentheses when Backspace removes the opening one, skip a duplicate
  // closing parenthesis, and turn common function names into function calls.
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

      if (inserted === "(") {
        const withClose =
          nextText[cursor + 1] === ")"
            ? nextText
            : nextText.slice(0, cursor + 1) + ")" + nextText.slice(cursor + 1);

        setEquationInput(withClose);
        previousEquationRef.current = withClose;
        setEquationCursor(cursor + 1);
        return;
      }

      // If a closing parenthesis is typed immediately before an existing
      // auto-inserted closing parenthesis, just move past the existing one.
      if (inserted === ")" && previous[cursor] === ")") {
        setEquationInput(previous);
        previousEquationRef.current = previous;
        setEquationCursor(cursor + 1);
        return;
      }
    }

    // If Backspace deleted an opening parenthesis, remove its matching
    // auto-inserted closing parenthesis too.
    if (
      nextText.length === previous.length - 1 &&
      oldSelection.start === oldSelection.end &&
      cursor > 0 &&
      previous[cursor - 1] === "(" &&
      previous[cursor] === ")"
    ) {
      const paired = nextText.slice(0, cursor - 1) + nextText.slice(cursor);
      setEquationInput(paired);
      previousEquationRef.current = paired;
      setEquationCursor(cursor - 1);
      return;
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

  const zoomGraph = (factor: number) => {
    // Keep the center fixed while changing BOTH axes. This is a true
    // coordinate-plane zoom: the graph gets larger/smaller on screen
    // instead of merely changing its horizontal proportions.
    const xCenter = (xMin + xMax) / 2;
    const yCenter = (yMinRef.current + yMaxRef.current) / 2;
    const xRange = Math.max(MIN_RANGE, Math.min(MAX_RANGE, (xMax - xMin) * factor));
    const yRange = Math.max(MIN_RANGE, Math.min(MAX_RANGE, (yMax - yMin) * factor));

    setXMin(xCenter - xRange / 2);
    setXMax(xCenter + xRange / 2);
    setYMin(yCenter - yRange / 2);
    setYMax(yCenter + yRange / 2);
  };

  const resetGraphView = () => {
    setXMin(HOME_X_MIN);
    setXMax(HOME_X_MAX);
    setYMin(HOME_Y_MIN);
    setYMax(HOME_Y_MAX);
  };

  const handlePlotEquation = () => {
    try {
      const cleaned = normalizeEquation(equationInput);
      const node = parse(cleaned);
      compiledRef.current = node.compile();
      setEquationError(null);
      setEquationVersion((v) => v + 1); // triggers resample below
    } catch (e) {
      compiledRef.current = null;
      setEquationError("Couldn't understand that equation.");
      setStrokes([]);
    }
  };

  // Resample the curve whenever the equation changes OR the drawing
  // area is measured/resized.
  useEffect(() => {
    if (!compiledRef.current || graphLayout.width === 0) {
      return;
    }

    const rawPoints: (Point | null)[] = [];
    for (let i = 0; i <= SAMPLE_COUNT; i++) {
      const gx = xMin + (i / SAMPLE_COUNT) * (xMax - xMin);
      let gy: number;
      try {
        gy = compiledRef.current.evaluate({ x: gx });
      } catch {
        gy = NaN;
      }

      if (typeof gy !== "number" || !isFinite(gy)) {
        rawPoints.push(null);
      } else {
        rawPoints.push(toScreen(gx, gy));
      }
    }

    // Break the curve into separate strokes at gaps and big jumps
    // (asymptotes) so we never draw or feel a phantom vertical wall.
    const maxJump = graphLayout.height * 1.5;
    const newStrokes: Point[][] = [];
    let current: Point[] = [];

    for (const p of rawPoints) {
      if (!p) {
        if (current.length > 1) newStrokes.push(current);
        current = [];
        continue;
      }
      const prev = current[current.length - 1];
      if (prev && Math.abs(p.y - prev.y) > maxJump) {
        if (current.length > 1) newStrokes.push(current);
        current = [p];
        continue;
      }
      current.push(p);
    }
    if (current.length > 1) newStrokes.push(current);

    setStrokes(newStrokes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equationVersion, graphLayout.width, graphLayout.height, xMin, xMax, yMin, yMax]);

  // ------------------------------------------------------------------
  // HAPTICS (shared by both modes — just needs a distance in pixels)
  // ------------------------------------------------------------------

  const lastPulseTime = useRef(0);
  const nextPulseDelay = useRef(9999);

  const triggerHapticIfDue = (distance: number) => {
    const now = Date.now();
    const MAX_DIST = 60;

    if (distance > MAX_DIST) {
      nextPulseDelay.current = 9999;
      return;
    }

    const minDelay = 40;
    const maxDelay = 400;
    const delay = minDelay + (distance / MAX_DIST) * (maxDelay - minDelay);
    nextPulseDelay.current = delay;

    if (now - lastPulseTime.current >= delay) {
      lastPulseTime.current = now;

      if (distance < 8) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      } else if (distance < 25) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  };

  // PanResponder is created exactly once (see below), so its handler
  // closures would otherwise freeze on the "mode" and "strokes" values
  // from that very first render. Refs give the handlers a way to always
  // read the current value instead.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const strokesRef = useRef(strokes);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const xMinRef = useRef(xMin);
  const xMaxRef = useRef(xMax);
  const yMinRef = useRef(yMin);
  const yMaxRef = useRef(yMax);
  useEffect(() => {
    xMinRef.current = xMin;
    xMaxRef.current = xMax;
    yMinRef.current = yMin;
    yMaxRef.current = yMax;
  }, [xMin, xMax, yMin, yMax]);

  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartXRangeRef = useRef<number | null>(null);
  const pinchStartYRangeRef = useRef<number | null>(null);

  const touchDistance = (touches: any[]) => {
    if (touches.length < 2) return 0;
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderMove: (evt) => {
        const { locationX, locationY, touches } = evt.nativeEvent;

        // Two fingers = pinch to zoom in/out in graph mode.
        if (modeRef.current === "graph" && touches.length >= 2) {
          const distance = touchDistance(touches);

          if (pinchStartDistanceRef.current === null) {
            pinchStartDistanceRef.current = distance;
            pinchStartXRangeRef.current = xMaxRef.current - xMinRef.current;
            pinchStartYRangeRef.current = yMaxRef.current - yMinRef.current;
          } else if (
            distance > 0 &&
            pinchStartXRangeRef.current !== null &&
            pinchStartYRangeRef.current !== null
          ) {
            const scale = pinchStartDistanceRef.current / distance;
            const nextXRange = Math.max(
              MIN_RANGE,
              Math.min(MAX_RANGE, pinchStartXRangeRef.current * scale)
            );
            const nextYRange = Math.max(
              MIN_RANGE,
              Math.min(MAX_RANGE, pinchStartYRangeRef.current * scale)
            );
            const xCenter = (xMinRef.current + xMaxRef.current) / 2;
            const yCenter = (yMinRef.current + yMaxRef.current) / 2;
            setXMin(xCenter - nextXRange / 2);
            setXMax(xCenter + nextXRange / 2);
            setYMin(yCenter - nextYRange / 2);
            setYMax(yCenter + nextYRange / 2);
          }

          setDebugDist(null);
          return;
        }

        // One finger keeps the original haptic graph/triangle interaction.
        const distance =
          modeRef.current === "shape"
            ? distanceToTriangle(locationX, locationY)
            : distanceToStrokes(locationX, locationY, strokesRef.current);

        setDebugDist(Number.isFinite(distance) ? Math.round(distance) : null);
        triggerHapticIfDue(distance);
      },

      onPanResponderRelease: () => {
        pinchStartDistanceRef.current = null;
        pinchStartXRangeRef.current = null;
        pinchStartYRangeRef.current = null;
        setDebugDist(null);
      },

      onPanResponderTerminate: () => {
        pinchStartDistanceRef.current = null;
        pinchStartXRangeRef.current = null;
        pinchStartYRangeRef.current = null;
        setDebugDist(null);
      },
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
                placeholder="e.g. y = x^2  or  sin(x)"
                placeholderTextColor="#888"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                selectTextOnFocus={false}
              />
              <Pressable style={styles.plotButton} onPress={handlePlotEquation}>
                <Text style={styles.plotButtonText}>Plot</Text>
              </Pressable>
            </View>

            <View style={styles.graphControlsRow}>
              <Pressable
                style={styles.graphControlButton}
                onPress={() => zoomGraph(2)}
              >
                <Text style={styles.graphControlText}>−</Text>
              </Pressable>
              <Pressable
                style={styles.graphControlButton}
                onPress={() => zoomGraph(0.5)}
              >
                <Text style={styles.graphControlText}>+</Text>
              </Pressable>
              <Pressable
                style={styles.homeButton}
                onPress={resetGraphView}
              >
                <Text style={styles.graphControlText}>⌂ Home</Text>
              </Pressable>
              <Text style={styles.zoomHint}>Pinch to zoom</Text>
            </View>
          </>
        )}

        {equationError && <Text style={styles.errorText}>{equationError}</Text>}
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
            <TriangleEdge a={TRIANGLE[0]} b={TRIANGLE[1]} />
            <TriangleEdge a={TRIANGLE[1]} b={TRIANGLE[2]} />
            <TriangleEdge a={TRIANGLE[2]} b={TRIANGLE[0]} />
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
              // Pick a "nice" grid step so tick marks stay readable while zooming.
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
              ? "Touch and drag to feel the triangle"
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

  graphControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },

  graphControlButton: {
    minWidth: 38,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#555",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b1b1b",
  },

  homeButton: {
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

  zoomHint: {
    color: "#888",
    fontSize: 12,
    marginLeft: 4,
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
