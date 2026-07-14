import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, Line, Rect, Stage } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Stroke, StrokePoint, StrokeTool } from "../types/api";
import { clamp, makeId } from "../lib/ids";

interface HandwritingCanvasProps {
  blockId: string;
  strokes: Stroke[];
  tool: StrokeTool;
  color: string;
  brushWidth: number;
  height: number;
  isLast: boolean;
  showBoundary: boolean;
  onChange: (strokes: Stroke[]) => void;
  onResize: (height: number) => void;
  onSelectionChange: (blockId: string, strokeIds: string[]) => void;
}

type DrawingState =
  | { mode: "none" }
  | { mode: "draw"; stroke: Stroke }
  | { mode: "erase" }
  | { mode: "lasso"; points: StrokePoint[] }
  | { mode: "drag"; pointer: StrokePoint; original: Stroke[] };

export function HandwritingCanvas({ blockId, strokes, tool, color, brushWidth, height, isLast, showBoundary, onChange, onResize, onSelectionChange }: HandwritingCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef(strokes);
  const [width, setWidth] = useState(320);
  const [drawing, setDrawing] = useState<DrawingState>({ mode: "none" });
  const [lassoPoints, setLassoPoints] = useState<StrokePoint[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const resize = () => setWidth(node.clientWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  useEffect(() => {
    setSelectedIds((ids) => ids.filter((id) => strokes.some((stroke) => stroke.id === id)));
  }, [strokes]);

  const selectedBounds = useMemo(() => {
    const selected = strokes.filter((stroke) => selectedIds.includes(stroke.id));
    if (selected.length === 0) return null;
    const points = selected.flatMap((stroke) => stroke.points);
    return {
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
  }, [selectedIds, strokes]);

  function pointerFromEvent(event: KonvaEventObject<PointerEvent>): StrokePoint | null {
    const stage = event.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!pointer) return null;
    const y = isLast ? Math.max(0, pointer.y) : clamp(pointer.y, 0, height);
    return { x: clamp(pointer.x, 0, width), y, t: performance.now(), pressure: event.evt.pressure || 0.5 };
  }

  function maybeExtend(point: StrokePoint) {
    if (isLast && point.y > height - 36) onResize(Math.ceil(point.y + 160));
  }

  function start(event: KonvaEventObject<PointerEvent>) {
    const point = pointerFromEvent(event);
    if (!point) return;
    event.evt.preventDefault();

    if (tool === "lasso" && selectedBounds && point.x >= selectedBounds.x - 16 && point.x <= selectedBounds.maxX + 16 && point.y >= selectedBounds.y - 16 && point.y <= selectedBounds.maxY + 16) {
      setDrawing({ mode: "drag", pointer: point, original: strokesRef.current });
      return;
    }

    if (tool === "lasso") {
      setLassoPoints([point]);
      setDrawing({ mode: "lasso", points: [point] });
      return;
    }

    if (tool === "eraser") {
      eraseAt(point);
      setDrawing({ mode: "erase" });
      return;
    }

    const stroke: Stroke = { id: makeId("stroke"), tool, color, width: brushWidth, points: [point] };
    maybeExtend(point);
    setDrawing({ mode: "draw", stroke });
    const next = [...strokesRef.current, stroke];
    strokesRef.current = next;
    onChange(next);
  }

  function move(event: KonvaEventObject<PointerEvent>) {
    const point = pointerFromEvent(event);
    if (!point) return;
    event.evt.preventDefault();

    if (tool === "eraser" && drawing.mode === "erase") {
      eraseAt(point);
      return;
    }

    if (drawing.mode === "draw") {
      maybeExtend(point);
      const nextStroke = { ...drawing.stroke, points: [...drawing.stroke.points, point] };
      setDrawing({ mode: "draw", stroke: nextStroke });
      const current = strokesRef.current.some((stroke) => stroke.id === nextStroke.id)
        ? strokesRef.current.map((stroke) => (stroke.id === nextStroke.id ? nextStroke : stroke))
        : [...strokesRef.current, nextStroke];
      strokesRef.current = current;
      onChange(current);
      return;
    }

    if (drawing.mode === "lasso") {
      const nextPoints = [...drawing.points, point];
      setLassoPoints(nextPoints);
      setDrawing({ mode: "lasso", points: nextPoints });
      return;
    }

    if (drawing.mode === "drag") {
      const dx = point.x - drawing.pointer.x;
      const dy = point.y - drawing.pointer.y;
      const next = drawing.original.map((stroke) =>
        selectedIds.includes(stroke.id)
          ? {
              ...stroke,
              points: stroke.points.map((strokePoint) => ({ ...strokePoint, x: clamp(strokePoint.x + dx, 0, width), y: clamp(strokePoint.y + dy, 0, height) })),
            }
          : stroke,
      );
      strokesRef.current = next;
      onChange(next);
    }
  }

  function end() {
    if (drawing.mode === "lasso") {
      const selected = selectStrokes(strokesRef.current, drawing.points);
      setSelectedIds(selected);
      onSelectionChange(blockId, selected);
    }
    setDrawing({ mode: "none" });
    setLassoPoints([]);
  }

  function eraseAt(point: StrokePoint) {
    const radius = Math.max(8, brushWidth * 2.4);
    const next = strokesRef.current.filter((stroke) => !stroke.points.some((strokePoint) => distance(strokePoint, point) <= radius));
    if (next.length !== strokesRef.current.length) {
      strokesRef.current = next;
      onChange(next);
    }
  }

  return (
    <div className={showBoundary ? "handwriting-canvas active" : "handwriting-canvas"} ref={containerRef}>
      <Stage height={height} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerLeave={end} width={width}>
        <Layer>
          {showBoundary && <Rect dash={[8, 8]} height={height - 2} stroke="#7c5c2f" strokeWidth={1} width={width - 2} x={1} y={1} />}
          {strokes.map((stroke) => (
            <Line
              globalCompositeOperation={stroke.tool === "highlighter" ? "multiply" : "source-over"}
              key={stroke.id}
              lineCap="round"
              lineJoin="round"
              opacity={stroke.tool === "highlighter" ? 0.35 : 1}
              points={stroke.points.flatMap((point) => [point.x, point.y])}
              stroke={selectedIds.includes(stroke.id) ? "#2c6cff" : stroke.color}
              strokeWidth={selectedIds.includes(stroke.id) ? stroke.width + 1.2 : stroke.width}
              tension={0.42}
            />
          ))}
          {lassoPoints.length > 1 && (
            <Line closed dash={[6, 6]} lineCap="round" lineJoin="round" points={lassoPoints.flatMap((point) => [point.x, point.y])} stroke="#2c6cff" strokeWidth={2} />
          )}
          {selectedBounds && (
            <Rect
              dash={[5, 6]}
              fill="rgba(44,108,255,0.05)"
              height={selectedBounds.maxY - selectedBounds.y + 18}
              stroke="#2c6cff"
              strokeWidth={1}
              width={selectedBounds.maxX - selectedBounds.x + 18}
              x={selectedBounds.x - 9}
              y={selectedBounds.y - 9}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}

function selectStrokes(strokes: Stroke[], polygon: StrokePoint[]) {
  if (polygon.length < 3) return [];
  return strokes
    .filter((stroke) => stroke.points.some((point) => pointInPolygon(point, polygon)))
    .map((stroke) => stroke.id);
}

function pointInPolygon(point: StrokePoint, polygon: StrokePoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distance(a: StrokePoint, b: StrokePoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
