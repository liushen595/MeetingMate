import { useEffect, useRef, useState } from "react";
import { Layer, Line, Rect, Stage } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Stroke, StrokePoint, StrokeTool } from "../types/api";
import { clamp, makeId } from "../lib/ids";

export function BlankHandwritingCanvas({ tool, color, brushWidth, onCommit }: { tool: StrokeTool; color: string; brushWidth: number; onCommit: (strokes: Stroke[], height: number) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const [height, setHeight] = useState(220);
  const [draft, setDraft] = useState<Stroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const resize = () => setWidth(node.clientWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function pointFromEvent(event: KonvaEventObject<PointerEvent>): StrokePoint | null {
    const pointer = event.target.getStage()?.getPointerPosition();
    if (!pointer) return null;
    return { x: clamp(pointer.x, 0, width), y: Math.max(0, pointer.y), t: Math.round(performance.now()), pressure: event.evt.pressure || 0.5 };
  }

  function start(event: KonvaEventObject<PointerEvent>) {
    if (tool === "lasso" || tool === "eraser") return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.evt.preventDefault();
    const stroke: Stroke = { id: makeId("stroke"), tool: tool === "highlighter" ? "highlighter" : "pen", color, width: Math.round(brushWidth), points: [point] };
    setDraft([stroke]);
    setActiveStroke(stroke);
  }

  function move(event: KonvaEventObject<PointerEvent>) {
    if (!activeStroke) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.evt.preventDefault();
    if (point.y > height - 36) setHeight(Math.ceil(point.y + 160));
    const nextStroke = { ...activeStroke, points: [...activeStroke.points, point] };
    setActiveStroke(nextStroke);
    setDraft([nextStroke]);
  }

  function end() {
    if (draft.length === 0) return;
    onCommit(draft, height);
    setDraft([]);
    setActiveStroke(null);
    setHeight(220);
  }

  return (
    <div className="blank-handwriting" ref={containerRef}>
      <Stage height={height} onPointerDown={start} onPointerLeave={end} onPointerMove={move} onPointerUp={end} width={width}>
        <Layer>
          <Rect fill="rgba(255,255,255,0.02)" height={height} width={width} />
          {draft.map((stroke) => (
            <Line
              key={stroke.id}
              lineCap="round"
              lineJoin="round"
              opacity={stroke.tool === "highlighter" ? 0.35 : 1}
              points={stroke.points.flatMap((point) => [point.x, point.y])}
              stroke={stroke.color}
              strokeWidth={stroke.width}
              tension={0.42}
            />
          ))}
        </Layer>
      </Stage>
      {draft.length === 0 && <div className="blank-hint">在空白稿纸写下去，会自动创建手写块</div>}
    </div>
  );
}
