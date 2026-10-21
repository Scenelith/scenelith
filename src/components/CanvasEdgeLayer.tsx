"use client";

import { useEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { sampleCanvasEdge } from "@/lib/canvas-edge-geometry";

const vertexSource = `#version 300 es
in vec2 point; in vec2 normal; in vec2 distanceSide;
in vec4 stroke; in vec4 tint; in vec3 effects;
uniform vec2 size; uniform vec3 view;
out vec2 distanceAcross; out vec4 ink; out vec4 line; out vec2 effect;
void main() {
  float scale = effects.z > .5 ? 1. / view.z : 1.;
  float width = stroke.x * scale;
  float radius = width + (effects.x > .5 ? 28. : 0.) + 2. / view.z;
  vec2 position = (point + normal * distanceSide.y * radius) * view.z + view.xy;
  gl_Position = vec4(position / size * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
  distanceAcross = vec2(distanceSide.x, distanceSide.y * radius);
  line = vec4(width, stroke.yz * scale, stroke.w);
  ink = tint; effect = effects.xy;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec2 distanceAcross; in vec4 ink; in vec4 line; in vec2 effect;
uniform float phase; uniform float zoom;
out vec4 color;
void main() {
  float aa = 1. / zoom;
  float across = abs(distanceAcross.y) - line.x;
  float shape = across;
  if (line.y > 0.) {
    float cycle = line.y + line.z;
    float along = mod(distanceAcross.x - phase * line.w, cycle);
    float dash = abs(along - line.y * .5) - line.y * .5;
    shape = effect.y > .5
      ? length(vec2(max(dash, 0.), distanceAcross.y)) - line.x
      : max(across, dash);
  }
  float alpha = 1. - smoothstep(-aa * .5, aa * .5, shape);
  if (effect.x > .5) {
    float outer = max(shape, 0.);
    float glow = .82 * exp(-outer * outer / 18.) + .42 * exp(-outer * outer / 162.);
    alpha = alpha + (1. - alpha) * min(glow, 1.);
  }
  color = vec4(ink.rgb, ink.a * alpha);
}`;

/** A single viewport-sized GPU surface; SVG remains the accessible hit target. */
export function CanvasEdgeLayer() {
  const ref = useRef<HTMLCanvasElement>(null);
  const store = useStoreApi();
  useEffect(() => {
    const canvas = ref.current;
    const root = canvas?.closest<HTMLElement>(".react-flow");
    const edges = root?.querySelector(".react-flow__edges");
    if (!canvas || !root || !edges) return;
    let gl: WebGL2RenderingContext | null;
    try { gl = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "low-power" }); }
    catch { return; }
    if (!gl) return; // Native SVG is the compatibility fallback.
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    if (!program || !buffer) return;
    const shaders: WebGLShader[] = [];
    let failed = false;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(type);
      if (!shader) { failed = true; break; }
      shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { failed = true; break; }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (failed || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      shaders.forEach((shader) => gl.deleteShader(shader)); gl.deleteProgram(program); gl.deleteBuffer(buffer);
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let offset = 0;
    const stride = 17;
    for (const [name, count] of [["point", 2], ["normal", 2], ["distanceSide", 2], ["stroke", 4], ["tint", 4], ["effects", 3]] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, count, gl.FLOAT, false, stride * 4, offset * 4);
      offset += count;
    }
    const size = gl.getUniformLocation(program, "size"), view = gl.getUniformLocation(program, "view");
    const phase = gl.getUniformLocation(program, "phase"), zoom = gl.getUniformLocation(program, "zoom");
    const maxSize = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const colorContext = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const colors = new Map<string, number[]>();
    const color = (value: string) => {
      const cached = colors.get(value);
      if (cached) return cached;
      if (!colorContext) return [0.59, 0.59, 0.61, 0.38];
      colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = value; colorContext.fillRect(0, 0, 1, 1);
      const result = Array.from(colorContext.getImageData(0, 0, 1, 1).data, (channel) => channel / 255);
      colors.set(value, result); return result;
    };
    let count = 0, frame = 0, dirty = true, animate = false, visible = true, disposed = false;
    let width = root.clientWidth, height = root.clientHeight;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const rebuild = () => {
      dirty = false; animate = false;
      const data: number[] = [];
      for (const path of edges.querySelectorAll<SVGPathElement>(".react-flow__edge-disconnectable > .react-flow__edge-path")) {
        const points = sampleCanvasEdge(path.getAttribute("d") || "");
        const style = getComputedStyle(path);
        if (points.length < 2 || style.stroke === "none") continue;
        const group = path.closest(".react-flow__edge")!;
        const dash = style.strokeDasharray.split(/[ ,]+/).map(parseFloat).filter(Number.isFinite);
        const isAnimated = group.classList.contains("animated");
        const duration = parseFloat(style.getPropertyValue("--canvas-edge-duration")) || .5;
        const speed = isAnimated ? 10 / duration : 0;
        animate ||= isAnimated && Boolean(dash.length);
        const rgba = color(style.stroke).slice(); rgba[3] *= Number(style.opacity);
        const stroke = [parseFloat(style.strokeWidth) / 2, dash[0] || 0, dash[1] || dash[0] || 0, speed];
        const effects = [style.filter !== "none" ? 1 : 0, style.strokeLinecap === "round" ? 1 : 0, style.vectorEffect === "non-scaling-stroke" ? 1 : 0];
        for (let index = 0; index < points.length - 1; index++) {
          const p = points[index], q = points[index + 1];
          const length = Math.hypot(q.x - p.x, q.y - p.y);
          if (!length) continue;
          for (const [point, side] of [[p, -1], [q, -1], [p, 1], [p, 1], [q, -1], [q, 1]] as const) {
            const pointIndex = point === p ? index : index + 1;
            const before = points[Math.max(0, pointIndex - 1)], after = points[Math.min(points.length - 1, pointIndex + 1)];
            const tangentLength = Math.hypot(after.x - before.x, after.y - before.y) || 1;
            const nx = -(after.y - before.y) / tangentLength, ny = (after.x - before.x) / tangentLength;
            data.push(point.x, point.y, nx, ny, point.distance, side, ...stroke, ...rgba, ...effects);
          }
        }
      }
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      count = data.length / stride;
    };
    const draw = (time: number) => {
      frame = 0;
      if (disposed || document.hidden || !visible || !width || !height || gl.isContextLost()) return;
      if (dirty) rebuild();
      // The backing store is bounded by the viewport, not the graph's world bounds.
      const ratio = Math.min(devicePixelRatio || 1, 2, maxSize[0] / width, maxSize[1] / height);
      const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      const [x, y, scale] = store.getState().transform;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(size, width, height); gl.uniform3f(view, x, y, scale); gl.uniform1f(zoom, scale);
      gl.uniform1f(phase, reduced.matches ? 0 : (time % 500) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      if (animate && !reduced.matches && count) frame = requestAnimationFrame(draw);
    };
    const schedule = () => { if (!frame && !disposed && !document.hidden && visible) frame = requestAnimationFrame(draw); };
    const invalidate = () => { dirty = true; schedule(); };
    const visibility = () => { if (frame) cancelAnimationFrame(frame); frame = 0; schedule(); };
    // CSS changes only affect the presentation, never the persisted graph.
    root.classList.add("canvas-gpu-edges");
    const mutations = new MutationObserver(invalidate);
    mutations.observe(edges, { subtree: true, childList: true, attributes: true, attributeFilter: ["d", "class", "style"] });
    const resize = new ResizeObserver(() => { width = root.clientWidth; height = root.clientHeight; schedule(); });
    resize.observe(root);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; visibility(); });
    intersection.observe(root);
    const unsubscribe = store.subscribe((state, previous) => { if (state.transform !== previous.transform) schedule(); });
    document.addEventListener("visibilitychange", visibility); reduced.addEventListener("change", invalidate);
    const lost = (event: Event) => {
      event.preventDefault(); if (frame) cancelAnimationFrame(frame); frame = 0;
      root.classList.remove("canvas-gpu-edges"); canvas.style.visibility = "hidden";
    };
    canvas.addEventListener("webglcontextlost", lost);
    schedule();
    return () => {
      disposed = true; if (frame) cancelAnimationFrame(frame);
      root.classList.remove("canvas-gpu-edges"); mutations.disconnect(); resize.disconnect(); intersection.disconnect(); unsubscribe();
      document.removeEventListener("visibilitychange", visibility); reduced.removeEventListener("change", invalidate);
      canvas.removeEventListener("webglcontextlost", lost);
      shaders.forEach((shader) => gl.deleteShader(shader)); gl.deleteBuffer(buffer); gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [store]);
  return <canvas ref={ref} className="canvas-edge-layer" aria-hidden="true" />;
}
