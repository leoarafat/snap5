/* Markup engine. All object coordinates are in image pixels; `unit` is image pixels per CSS pixel. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const BOX_TYPES = new Set(['rect', 'ellipse', 'blur', 'pixelate', 'spotlight', 'magnify', 'image', 'redact']);
  const LINE_TYPES = new Set(['line', 'arrow', 'measure']);
  const PATH_TYPES = new Set(['pen', 'highlight']);
  const FONT = 'system-ui, -apple-system, "Segoe UI", "Kohinoor Bangla", "Noto Sans Bengali", sans-serif';

  const rectOf = (o) => ({
    x: Math.min(o.x1, o.x2),
    y: Math.min(o.y1, o.y2),
    w: Math.abs(o.x2 - o.x1),
    h: Math.abs(o.y2 - o.y1),
  });

  const segmentDistance = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };

  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };

  class Annotator {
    constructor({ base, canvas, unit = 1, host, onChange, onPickColor, style }) {
      this.base = base;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.unit = unit;
      this.host = host;
      this.onChange = onChange || (() => {});
      this.onPickColor = onPickColor || (() => {});
      this.objects = [];
      this.undoStack = [];
      this.redoStack = [];
      this.selected = null;
      this.tool = 'move';
      this.style = { color: '#ef4444', size: 4, filled: false, fontSize: 22, emoji: '👍', textBg: false, ...style };
      this.drag = null;
      this.editing = null;
      this.pendingFrame = 0;
      canvas.width = base.width;
      canvas.height = base.height;
      this.render();
    }

    /* ---------- state ---------- */

    snapshot() {
      return { base: this.base, objects: this.objects.map((o) => ({ ...o, points: o.points?.map((p) => ({ ...p })) })) };
    }

    commit(before) {
      this.undoStack.push(before);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack.length = 0;
      this.changed();
    }

    restore(state) {
      this.base = state.base;
      this.objects = state.objects;
      this.selected = null;
      if (this.canvas.width !== this.base.width || this.canvas.height !== this.base.height) {
        this.canvas.width = this.base.width;
        this.canvas.height = this.base.height;
      }
      this.changed();
    }

    undo() {
      this.finishText();
      if (!this.undoStack.length) return;
      this.redoStack.push(this.snapshot());
      this.restore(this.undoStack.pop());
    }

    redo() {
      this.finishText();
      if (!this.redoStack.length) return;
      this.undoStack.push(this.snapshot());
      this.restore(this.redoStack.pop());
    }

    changed() {
      this.render();
      this.onChange(this);
    }

    setTool(tool) {
      this.finishText();
      this.tool = tool;
      if (tool !== 'move') this.selected = null;
      this.changed();
    }

    /* Style changes also restyle the selected object. */
    setStyle(patch) {
      Object.assign(this.style, patch);
      if (this.editing) this.styleEditor();
      else if (this.selected) {
        const before = this.snapshot();
        const o = this.selected;
        if ('color' in patch) o.color = patch.color;
        if ('size' in patch) o.size = patch.size;
        if ('filled' in patch) o.filled = patch.filled;
        if ('fontSize' in patch && o.type === 'text') o.fontSize = patch.fontSize * this.unit;
        if ('textBg' in patch && o.type === 'text') o.textBg = patch.textBg;
        this.commit(before);
        return;
      }
      this.changed();
    }

    add(object) {
      const before = this.snapshot();
      this.objects.push(object);
      this.commit(before);
      return object;
    }

    deleteSelected() {
      if (!this.selected) return false;
      const before = this.snapshot();
      this.objects = this.objects.filter((o) => o !== this.selected);
      this.selected = null;
      this.commit(before);
      return true;
    }

    clearAll() {
      this.finishText();
      if (!this.objects.length) return;
      const before = this.snapshot();
      this.objects = [];
      this.selected = null;
      this.commit(before);
    }

    duplicate() {
      if (!this.selected) return;
      const copy = { ...this.selected, points: this.selected.points?.map((p) => ({ ...p })) };
      this.translate(copy, 16 * this.unit, 16 * this.unit);
      this.add(copy);
      this.selected = copy;
      this.changed();
    }

    nudge(dx, dy) {
      if (!this.selected) return false;
      const before = this.snapshot();
      this.translate(this.selected, dx * this.unit, dy * this.unit);
      this.commit(before);
      return true;
    }

    /* Replace the background image (crop, rotate, resize, beautify). Undoable. */
    replaceBase(base, objects) {
      const before = this.snapshot();
      this.base = base;
      this.objects = objects;
      this.selected = null;
      this.canvas.width = base.width;
      this.canvas.height = base.height;
      this.commit(before);
    }

    crop(r) {
      const x = Math.max(0, Math.round(r.x));
      const y = Math.max(0, Math.round(r.y));
      const w = Math.min(this.base.width - x, Math.round(r.w));
      const h = Math.min(this.base.height - y, Math.round(r.h));
      if (w < 2 || h < 2) return;
      const base = document.createElement('canvas');
      base.width = w;
      base.height = h;
      base.getContext('2d').drawImage(this.base, x, y, w, h, 0, 0, w, h);
      const objects = this.snapshot().objects;
      objects.forEach((o) => this.translate(o, -x, -y));
      this.replaceBase(base, objects);
    }

    translate(o, dx, dy) {
      if (o.points) o.points.forEach((p) => { p.x += dx; p.y += dy; });
      if ('x1' in o) { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
      if ('x' in o) { o.x += dx; o.y += dy; }
    }

    /* ---------- geometry ---------- */

    bounds(o) {
      if (BOX_TYPES.has(o.type)) return rectOf(o);
      if (LINE_TYPES.has(o.type)) return rectOf(o);
      if (PATH_TYPES.has(o.type)) {
        const xs = o.points.map((p) => p.x);
        const ys = o.points.map((p) => p.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      if (o.type === 'number' || o.type === 'emoji') return { x: o.x - o.r, y: o.y - o.r, w: o.r * 2, h: o.r * 2 };
      if (o.type === 'text') {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = `600 ${o.fontSize}px ${FONT}`;
        const lines = o.text.split('\n');
        const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
        ctx.restore();
        const pad = o.fontSize * 0.3;
        return { x: o.x - pad, y: o.y - pad, w: w + pad * 2, h: lines.length * o.fontSize * 1.35 + pad * 2 };
      }
      return { x: 0, y: 0, w: 0, h: 0 };
    }

    hit(point) {
      const slack = 8 * this.unit;
      for (let i = this.objects.length - 1; i >= 0; i--) {
        const o = this.objects[i];
        const width = ((o.size || 4) * this.unit) / 2 + slack;
        if (LINE_TYPES.has(o.type)) {
          if (segmentDistance(point.x, point.y, o.x1, o.y1, o.x2, o.y2) <= width) return o;
          continue;
        }
        if (PATH_TYPES.has(o.type)) {
          const reach = o.type === 'highlight' ? width * 3 : width;
          const pts = o.points;
          for (let j = 0; j < pts.length; j++) {
            const q = pts[Math.min(j + 1, pts.length - 1)];
            if (segmentDistance(point.x, point.y, pts[j].x, pts[j].y, q.x, q.y) <= reach) return o;
          }
          continue;
        }
        const b = this.bounds(o);
        const inside = point.x >= b.x - slack && point.x <= b.x + b.w + slack && point.y >= b.y - slack && point.y <= b.y + b.h + slack;
        if (!inside) continue;
        // Outlined shapes are only grabbed near their edge, so you can work inside them.
        if ((o.type === 'rect' || o.type === 'spotlight') && !o.filled && b.w > slack * 4 && b.h > slack * 4) {
          const deep = point.x > b.x + width && point.x < b.x + b.w - width && point.y > b.y + width && point.y < b.y + b.h - width;
          if (deep && o !== this.selected) continue;
        }
        return o;
      }
      return null;
    }

    handles(o) {
      if (LINE_TYPES.has(o.type)) return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
      if (!BOX_TYPES.has(o.type)) return [];
      const r = rectOf(o);
      const xs = { w: r.x, m: r.x + r.w / 2, e: r.x + r.w };
      const ys = { n: r.y, m: r.y + r.h / 2, s: r.y + r.h };
      return ['nw', 'nm', 'ne', 'mw', 'me', 'sw', 'sm', 'se'].map((id) => ({ id, x: xs[id[1]], y: ys[id[0]] }));
    }

    handleAt(point) {
      if (!this.selected) return null;
      return this.handles(this.selected).find((h) => Math.hypot(h.x - point.x, h.y - point.y) <= 9 * this.unit) || null;
    }

    cursorFor(point) {
      if (this.tool === 'text') return 'text';
      if (this.tool !== 'move') return 'crosshair';
      const h = this.handleAt(point);
      if (h) {
        const map = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', nm: 'ns-resize', sm: 'ns-resize', mw: 'ew-resize', me: 'ew-resize' };
        return map[h.id] || 'grab';
      }
      return this.hit(point) ? 'move' : null;
    }

    /* ---------- pointer ---------- */

    toImage(event) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - r.left) * this.canvas.width) / r.width,
        y: ((event.clientY - r.top) * this.canvas.height) / r.height,
      };
    }

    /* Returns false when the press was not used, so the host can move the selection instead. */
    down(event) {
      if (this.editing) {
        this.finishText();
        if (this.tool === 'text') return true;
      }
      const p = this.toImage(event);
      const { tool, style, unit } = this;

      if (tool === 'move') {
        const handle = this.handleAt(p);
        if (handle) {
          const o = this.selected;
          if (BOX_TYPES.has(o.type)) Object.assign(o, (({ x, y, w, h }) => ({ x1: x, y1: y, x2: x + w, y2: y + h }))(rectOf(o)));
          this.drag = { kind: 'resize', handle: handle.id, before: this.snapshot(), moved: false };
          // snapshot() copies objects, so `selected` still points at the live one.
          return true;
        }
        const target = this.hit(p);
        const had = this.selected;
        this.selected = target;
        this.render();
        this.onChange(this);
        if (!target) return !!had;
        this.drag = { kind: 'move', last: p, before: this.snapshot(), moved: false };
        return true;
      }

      if (tool === 'text') {
        const existing = this.hit(p);
        this.startText(existing?.type === 'text' ? existing : null, p);
        return true;
      }

      if (tool === 'eyedropper') {
        this.onPickColor(this.pixelAt(p));
        return true;
      }

      if (tool === 'number') {
        const next = this.objects.reduce((m, o) => (o.type === 'number' ? Math.max(m, o.value) : m), 0) + 1;
        this.add({ type: 'number', x: p.x, y: p.y, r: (10 + style.size * 1.2) * unit, value: next, color: style.color });
        return true;
      }

      if (tool === 'emoji') {
        this.add({ type: 'emoji', x: p.x, y: p.y, r: (14 + style.size * 2) * unit, emoji: style.emoji });
        return true;
      }

      const before = this.snapshot();
      const object = { type: tool, color: style.color, size: style.size, filled: style.filled };
      if (PATH_TYPES.has(tool)) object.points = [p];
      else Object.assign(object, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      this.objects.push(object);
      this.drag = { kind: 'draw', object, before };
      this.render();
      return true;
    }

    move(event) {
      const drag = this.drag;
      if (!drag) return;
      const p = this.toImage(event);
      if (drag.kind === 'move') {
        const dx = p.x - drag.last.x;
        const dy = p.y - drag.last.y;
        if (!drag.moved && Math.hypot(dx, dy) < 2) return;
        this.translate(this.selected, dx, dy);
        drag.last = p;
        drag.moved = true;
      } else if (drag.kind === 'resize') {
        const o = this.selected;
        const id = drag.handle;
        if (id === 'p1') Object.assign(o, { x1: p.x, y1: p.y });
        else if (id === 'p2') Object.assign(o, { x2: p.x, y2: p.y });
        else {
          if (id[0] === 'n') o.y1 = p.y;
          if (id[0] === 's') o.y2 = p.y;
          if (id[1] === 'w') o.x1 = p.x;
          if (id[1] === 'e') o.x2 = p.x;
        }
        drag.moved = true;
      } else {
        const o = drag.object;
        if (o.points) {
          if (o.type === 'highlight' && event.shiftKey) o.points = [o.points[0], { x: p.x, y: o.points[0].y }];
          else o.points.push(p);
        } else {
          let { x, y } = p;
          if (event.shiftKey) {
            const dx = x - o.x1;
            const dy = y - o.y1;
            if (LINE_TYPES.has(o.type)) {
              const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
              const len = Math.hypot(dx, dy);
              x = o.x1 + Math.cos(angle) * len;
              y = o.y1 + Math.sin(angle) * len;
            } else {
              const side = Math.max(Math.abs(dx), Math.abs(dy));
              x = o.x1 + side * Math.sign(dx || 1);
              y = o.y1 + side * Math.sign(dy || 1);
            }
          }
          o.x2 = x;
          o.y2 = y;
        }
      }
      this.scheduleRender();
    }

    up() {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      if (drag.kind === 'draw') {
        const o = drag.object;
        const b = this.bounds(o);
        if (!o.points && Math.hypot(b.w, b.h) < 4 * this.unit) {
          this.objects = this.objects.filter((x) => x !== o);
          this.changed();
          return;
        }
        this.commit(drag.before);
      } else if (drag.moved) {
        this.commit(drag.before);
      }
    }

    doubleClick(event) {
      const target = this.hit(this.toImage(event));
      if (target?.type !== 'text') return false;
      this.startText(target);
      return true;
    }

    /* ---------- text editing ---------- */

    startText(existing, point) {
      this.finishText();
      const before = this.snapshot();
      const object = existing || {
        type: 'text', x: point.x, y: point.y - (this.style.fontSize * this.unit) / 2, text: '',
        color: this.style.color, fontSize: this.style.fontSize * this.unit, textBg: this.style.textBg,
      };
      if (existing) this.objects = this.objects.filter((o) => o !== existing);
      const input = document.createElement('textarea');
      input.className = 'snap5-text-input';
      input.spellcheck = false;
      input.value = object.text;
      input.placeholder = 'Type here…';
      this.editing = { object, input, before, existing: !!existing };
      this.selected = null;
      this.host.append(input);
      this.styleEditor(false);
      input.addEventListener('input', () => this.sizeEditor());
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          this.finishText();
        }
      });
      this.render();
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }

    styleEditor(applyStyle = true) {
      if (!this.editing) return;
      const { object, input } = this.editing;
      if (applyStyle) {
        Object.assign(object, { color: this.style.color, fontSize: this.style.fontSize * this.unit, textBg: this.style.textBg });
      }
      const canvasRect = this.canvas.getBoundingClientRect();
      const hostRect = this.host.getBoundingClientRect();
      const k = canvasRect.width / this.canvas.width;
      Object.assign(input.style, {
        left: `${canvasRect.left - hostRect.left + this.host.scrollLeft + object.x * k}px`,
        top: `${canvasRect.top - hostRect.top + this.host.scrollTop + object.y * k}px`,
        font: `600 ${object.fontSize * k}px/1.35 ${FONT}`,
        color: object.textBg ? (luminance(object.color) > 0.6 ? '#111' : '#fff') : object.color,
        background: object.textBg ? object.color : 'rgba(127,127,127,.12)',
      });
      this.sizeEditor();
    }

    sizeEditor() {
      const { input } = this.editing;
      input.style.width = '10px';
      input.style.height = '10px';
      input.style.width = `${Math.max(140, input.scrollWidth + 12)}px`;
      input.style.height = `${input.scrollHeight}px`;
    }

    finishText() {
      if (!this.editing) return;
      const { object, input, before, existing } = this.editing;
      this.editing = null;
      object.text = input.value.replace(/\s+$/, '');
      input.remove();
      if (object.text) {
        this.objects.push(object);
        this.commit(before);
      } else if (existing) this.commit(before);
      else this.changed();
    }

    /* ---------- drawing ---------- */

    scheduleRender() {
      if (this.pendingFrame) return;
      this.pendingFrame = requestAnimationFrame(() => {
        this.pendingFrame = 0;
        this.render();
      });
    }

    render(showSelection = true) {
      const { ctx, canvas } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.base, 0, 0);
      const spots = [];
      for (const o of this.objects) {
        if (o.type === 'spotlight') spots.push(o);
        else this.draw(ctx, o);
      }
      if (spots.length) {
        // One dim layer with holes, so several spotlights never darken each other.
        const dim = (this.dimCanvas ||= document.createElement('canvas'));
        dim.width = canvas.width;
        dim.height = canvas.height;
        const d = dim.getContext('2d');
        d.fillStyle = 'rgba(0,0,0,.6)';
        d.fillRect(0, 0, dim.width, dim.height);
        d.globalCompositeOperation = 'destination-out';
        for (const o of spots) {
          const r = rectOf(o);
          d.beginPath();
          d.roundRect(r.x, r.y, r.w, r.h, 8 * this.unit);
          d.fill();
        }
        d.globalCompositeOperation = 'source-over';
        ctx.drawImage(dim, 0, 0);
      }
      if (showSelection && this.selected) this.drawSelection(this.selected);
    }

    draw(ctx, o) {
      const u = this.unit;
      const width = (o.size || 4) * u;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = o.color;
      ctx.fillStyle = o.color;
      ctx.lineWidth = width;
      const shadow = () => {
        ctx.shadowColor = 'rgba(0,0,0,.28)';
        ctx.shadowBlur = 3 * u;
        ctx.shadowOffsetY = u;
      };

      switch (o.type) {
        case 'pen':
        case 'highlight': {
          if (o.type === 'highlight') {
            ctx.globalAlpha = 0.45;
            ctx.globalCompositeOperation = 'multiply';
            ctx.lineWidth = (10 + o.size * 2.5) * u;
            ctx.lineCap = 'butt';
          }
          const pts = o.points;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length - 1; i++) {
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
          }
          const end = pts[pts.length - 1];
          ctx.lineTo(end.x + (pts.length === 1 ? 0.1 : 0), end.y);
          ctx.stroke();
          break;
        }
        case 'line':
          shadow();
          ctx.beginPath();
          ctx.moveTo(o.x1, o.y1);
          ctx.lineTo(o.x2, o.y2);
          ctx.stroke();
          break;
        case 'arrow': {
          shadow();
          const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
          const length = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          const head = Math.min(length * 0.6, (11 + o.size * 2.8) * u);
          const half = head * 0.55;
          const tail = Math.max(width * 0.35, u);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const at = (along, side) => [o.x1 + cos * along - sin * side, o.y1 + sin * along + cos * side];
          const neck = length - head * 0.85;
          ctx.beginPath();
          ctx.moveTo(...at(0, tail / 2));
          ctx.lineTo(...at(neck, width * 0.75));
          ctx.lineTo(...at(length - head, half));
          ctx.lineTo(o.x2, o.y2);
          ctx.lineTo(...at(length - head, -half));
          ctx.lineTo(...at(neck, -width * 0.75));
          ctx.lineTo(...at(0, -tail / 2));
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'measure': {
          const length = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
          ctx.lineWidth = Math.max(u, width * 0.5);
          ctx.beginPath();
          ctx.moveTo(o.x1, o.y1);
          ctx.lineTo(o.x2, o.y2);
          for (const [x, y] of [[o.x1, o.y1], [o.x2, o.y2]]) {
            ctx.moveTo(x + Math.sin(angle) * 7 * u, y - Math.cos(angle) * 7 * u);
            ctx.lineTo(x - Math.sin(angle) * 7 * u, y + Math.cos(angle) * 7 * u);
          }
          ctx.stroke();
          const label = `${Math.round(length / u)} px`;
          ctx.font = `600 ${13 * u}px ${FONT}`;
          const w = ctx.measureText(label).width + 12 * u;
          const mx = (o.x1 + o.x2) / 2;
          const my = (o.y1 + o.y2) / 2;
          ctx.beginPath();
          ctx.roundRect(mx - w / 2, my - 11 * u, w, 22 * u, 5 * u);
          ctx.fill();
          ctx.fillStyle = luminance(o.color) > 0.6 ? '#111' : '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, mx, my);
          break;
        }
        case 'rect':
        case 'ellipse': {
          shadow();
          const r = rectOf(o);
          ctx.beginPath();
          if (o.type === 'rect') ctx.roundRect(r.x, r.y, r.w, r.h, 4 * u);
          else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          if (o.filled) ctx.fill();
          else ctx.stroke();
          break;
        }
        case 'redact': {
          const r = rectOf(o);
          ctx.fillStyle = '#0a0a0a';
          ctx.fillRect(r.x, r.y, r.w, r.h);
          break;
        }
        case 'blur':
        case 'pixelate':
          this.obscure(ctx, o);
          break;
        case 'magnify': {
          const r = rectOf(o);
          if (r.w < 2 || r.h < 2) break;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          const zoom = 2;
          const source = document.createElement('canvas');
          source.width = Math.max(1, Math.round(r.w / zoom));
          source.height = Math.max(1, Math.round(r.h / zoom));
          source.getContext('2d').drawImage(ctx.canvas, cx - source.width / 2, cy - source.height / 2, source.width, source.height, 0, 0, source.width, source.height);
          ctx.beginPath();
          ctx.ellipse(cx, cy, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,.45)';
          ctx.shadowBlur = 14 * u;
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.clip();
          ctx.drawImage(source, r.x, r.y, r.w, r.h);
          ctx.restore();
          ctx.lineWidth = Math.max(2 * u, width * 0.7);
          ctx.stroke();
          break;
        }
        case 'number':
          shadow();
          ctx.beginPath();
          ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.lineWidth = 2 * u;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.fillStyle = luminance(o.color) > 0.6 ? '#111' : '#fff';
          ctx.font = `700 ${o.r * (o.value > 9 ? 0.95 : 1.15)}px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(o.value), o.x, o.y + o.r * 0.05);
          break;
        case 'emoji':
          ctx.fillStyle = '#000';
          ctx.font = `${o.r * 1.7}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(o.emoji, o.x, o.y + o.r * 0.1);
          break;
        case 'image': {
          const r = rectOf(o);
          ctx.drawImage(o.image, r.x, r.y, r.w, r.h);
          break;
        }
        case 'text': {
          const b = this.bounds(o);
          ctx.font = `600 ${o.fontSize}px ${FONT}`;
          ctx.textBaseline = 'middle';
          if (o.textBg) {
            shadow();
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, o.fontSize * 0.28);
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.fillStyle = luminance(o.color) > 0.6 ? '#111' : '#fff';
          } else {
            // A thin contrast halo keeps text readable on any background.
            ctx.strokeStyle = luminance(o.color) > 0.6 ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.9)';
            ctx.lineWidth = o.fontSize * 0.16;
          }
          o.text.split('\n').forEach((line, i) => {
            const y = o.y + o.fontSize * 1.35 * (i + 0.5);
            if (!o.textBg) ctx.strokeText(line, o.x, y);
            ctx.fillText(line, o.x, y);
          });
          break;
        }
      }
      ctx.restore();
    }

    /* Blur / pixelate whatever is currently on the canvas under the box. */
    obscure(ctx, o) {
      const r = rectOf(o);
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      const w = Math.min(ctx.canvas.width, Math.ceil(r.x + r.w)) - x;
      const h = Math.min(ctx.canvas.height, Math.ceil(r.y + r.h)) - y;
      if (w < 2 || h < 2) return;
      const strength = (o.size || 4) * this.unit;
      const temp = document.createElement('canvas');
      if (o.type === 'pixelate') {
        const block = Math.max(6 * this.unit, strength * 2.2);
        temp.width = Math.max(1, Math.round(w / block));
        temp.height = Math.max(1, Math.round(h / block));
        temp.getContext('2d').drawImage(ctx.canvas, x, y, w, h, 0, 0, temp.width, temp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(temp, 0, 0, temp.width, temp.height, x, y, w, h);
        return;
      }
      temp.width = w;
      temp.height = h;
      temp.getContext('2d').drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
      const radius = Math.max(5 * this.unit, strength * 1.8);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${radius}px)`;
      // Over-draw so the blur has no transparent fringe at the box edges.
      ctx.drawImage(temp, x - radius, y - radius, w + radius * 2, h + radius * 2);
      ctx.drawImage(temp, x - radius, y - radius, w + radius * 2, h + radius * 2);
    }

    drawSelection(o) {
      const { ctx } = this;
      const u = this.canvas.width / (this.canvas.getBoundingClientRect().width || this.canvas.width);
      const b = this.bounds(o);
      ctx.save();
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 1.5 * u;
      if (!LINE_TYPES.has(o.type)) {
        ctx.setLineDash([5 * u, 4 * u]);
        ctx.strokeRect(b.x - 3 * u, b.y - 3 * u, b.w + 6 * u, b.h + 6 * u);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#fff';
      for (const h of this.handles(o)) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, 5 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    pixelAt(p) {
      const d = this.ctx.getImageData(
        Math.max(0, Math.min(this.canvas.width - 1, Math.floor(p.x))),
        Math.max(0, Math.min(this.canvas.height - 1, Math.floor(p.y))), 1, 1,
      ).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    }

    /* Flattened copy of the whole image or of one region. */
    export(region) {
      this.finishText();
      this.render(false);
      const r = region || { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(r.w));
      out.height = Math.max(1, Math.round(r.h));
      out.getContext('2d').drawImage(this.canvas, Math.round(r.x), Math.round(r.y), out.width, out.height, 0, 0, out.width, out.height);
      this.render();
      return out;
    }
  }

  S.Annotator = Annotator;
})();
