'use strict';
// Gráficos em SVG puro (sem bibliotecas), coloridos: animação de entrada, destaque ao passar o mouse,
// tooltip, legenda clicável (liga/desliga séries) e clique para detalhar.
// No celular: o 1º toque mostra o tooltip, o 2º toque no mesmo item abre o detalhe.

const CHARTS = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;
  const tip = () => document.getElementById('tip');

  function compact(v) {
    const a = Math.abs(v);
    const f = (x, d) => x.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
    if (a >= 1e9) return f(v / 1e9, 2) + ' bi';
    if (a >= 999500) return f(v / 1e6, a >= 1e8 ? 0 : 1) + ' mi';
    if (a >= 1e3) return f(v / 1e3, 0) + ' mil';
    return f(v, 0);
  }
  const brl = v => (v == null || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const pctTxt = (a, b) => (b ? (a / b * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const width = (c, opts) => opts.width || c.clientWidth || 720;

  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + w > window.innerWidth - 8) left = x - w - 16;
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = y - h - 16;
    if (top < 8) top = 8;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  function hideTip() { tip().hidden = true; }
  const swatch = d => (d.hatch ? 'background:repeating-linear-gradient(45deg,var(--ink-2) 0 2px,var(--surface) 2px 4px)' : `background:${d.color}`);
  const tipRow = (d, name, value) =>
    `<div class="r"><span>${d ? `<i class="dot" style="${swatch(d)}"></i>` : ''}${esc(name)}</span><span>${esc(value)}</span></div>`;

  // Liga hover/toque/clique a uma função que descobre o item sob o ponteiro.
  function interact(svg, find, { onEnter, onLeave, onClick }) {
    let atual = null, ultimoToque = null;
    const sair = () => { atual = null; hideTip(); onLeave && onLeave(); };
    svg.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const it = find(e);
      if (!it) return sair();
      if (it.id !== (atual && atual.id)) { atual = it; onEnter && onEnter(it); }
      showTip(it.html, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') sair(); });
    svg.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const it = find(e);
      if (!it) { ultimoToque = null; return sair(); }
      onEnter && onEnter(it);
      showTip(it.html, e.clientX, e.clientY);
      if (onClick && it.click && ultimoToque === it.id) { hideTip(); onClick(it); ultimoToque = null; return; }
      ultimoToque = it.id;
    });
    svg.addEventListener('click', e => {
      if (e.pointerType === 'touch' || !onClick) return;
      const it = find(e);
      if (it && it.click) { hideTip(); onClick(it); }
    });
  }
  const pt = (svg, e, W, H) => {
    const b = svg.getBoundingClientRect();
    return { x: (e.clientX - b.left) * (W / b.width), y: (e.clientY - b.top) * (H / b.height) };
  };

  function niceTicks(min, max, count) {
    if (max === min) max = min + 1;
    const raw = (max - min) / count;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw) || raw;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }

  // Estado por gráfico: séries desligadas e se precisa animar.
  function estado(container, opts) {
    const st = container._st || (container._st = { hidden: new Set(), key: null });
    if (st.key !== opts.key) st.hidden.clear();
    const anim = opts.animate !== false && st.key !== opts.key;
    st.key = opts.key;
    return { st, anim };
  }
  function legend(container, items, st, redraw, cls = '') {
    const d = document.createElement('div');
    d.className = 'legend ' + cls;
    items.forEach(i => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!st.hidden.has(i.key)));
      b.title = 'Clique para mostrar/ocultar';
      const marca = i.line ? `<i class="line" style="border-top-color:${i.color};${i.dash ? 'border-top-style:' + (i.dash.startsWith('2 ') ? 'dotted' : 'dashed') : ''}"></i>` : `<i style="${swatch(i)}"></i>`;
      b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px">${marca}${esc(i.name)}</span>${i.valor ? `<span class="valor">${esc(i.valor)}</span>` : ''}`;
      b.addEventListener('click', () => {
        if (st.hidden.has(i.key)) st.hidden.delete(i.key);
        else if (items.length - st.hidden.size > 1) st.hidden.add(i.key);
        redraw();
      });
      d.appendChild(b);
    });
    container.appendChild(d);
  }
  function hatchDef(svg) {
    const id = 'hatch' + (++uid);
    const defs = el('defs', {}, svg);
    const p = el('pattern', { id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 5, height: 5, style: 'fill:var(--surface)' }, p);
    el('rect', { width: 2, height: 5, style: 'fill:var(--ink-2)' }, p);
    return `url(#${id})`;
  }
  const roundTop = (x, y, w, h, r) => `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  function roundRow(x, y, w, h, rl, rr) {
    return `M${x + rl},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x + rl} Q${x},${y + h} ${x},${y + h - rl} V${y + rl} Q${x},${y} ${x + rl},${y} Z`;
  }

  // ---------- Rosca (composição) ----------
  function donut(container, segs, opts = {}) {
    const { st, anim } = estado(container, opts);
    const redraw = () => donut(container, segs, { ...opts, animate: false });
    container.innerHTML = '';
    const vis = segs.filter(s => !st.hidden.has(s.key) && s.v > 0);
    const total = vis.reduce((a, s) => a + s.v, 0) || 1;
    const S = Math.min(240, width(container, opts)), R = S / 2 - 4, r = R * 0.64, cx = S / 2, cy = S / 2;
    const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': opts.aria || 'Composição', class: anim ? 'anim' : '', style: `max-width:${S}px;margin:0 auto` }, container);
    const g = el('g', { class: 'pop' }, svg);
    let a0 = -Math.PI / 2;
    const arcs = [];
    vis.forEach(s => {
      const a1 = a0 + (s.v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const d = vis.length === 1
        ? `M${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`
        : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
      const path = el('path', { d, class: 'mark', style: `fill:${s.color};stroke:var(--surface);stroke-width:2;fill-rule:evenodd` }, g);
      arcs.push({ s, a0, a1, path });
      a0 = a1;
    });
    const tv = el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'centro-v' }, svg);
    const tk = el('text', { x: cx, y: cy + 24, 'text-anchor': 'middle', class: 'centro-k' }, svg);
    const centro = (v, k) => { tv.textContent = v; tk.textContent = k; };
    centro(opts.centroValor || '', opts.centroRotulo || '');
    interact(svg, e => {
      const q = pt(svg, e, S, S);
      const dx = q.x - cx, dy = q.y - cy, dist = Math.hypot(dx, dy);
      if (dist < r || dist > R + 2) return null;
      let ang = Math.atan2(dy, dx); if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const a = arcs.find(x => ang >= x.a0 && ang < x.a1);
      return a && { id: a.s.key, a, html: `<b>${esc(a.s.name)}</b>` + tipRow(null, 'Valor', brl(a.s.v)) + tipRow(null, 'Participação', pctTxt(a.s.v, total)) };
    }, {
      onEnter: it => { arcs.forEach(x => x.path.classList.toggle('dim', x !== it.a)); centro(pctTxt(it.a.s.v, total), it.a.s.name); },
      onLeave: () => { arcs.forEach(x => x.path.classList.remove('dim')); centro(opts.centroValor || '', opts.centroRotulo || ''); }
    });
    legend(container, segs.map(s => ({ ...s, valor: compact(s.v) })), st, redraw, 'lista');
  }

  // ---------- Barras horizontais 100% empilhadas ----------
  function stackBars(container, rows, segDefs, opts = {}) {
    const { st, anim } = estado(container, opts);
    const redraw = () => stackBars(container, rows, segDefs, { ...opts, animate: false });
    container.innerHTML = '';
    legend(container, segDefs, st, redraw);
    const W = Math.max(280, width(container, opts)), rowH = 54, barH = 20;
    const H = rows.length * rowH;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.aria || 'Barras por obra', class: anim ? 'anim' : '' }, container);
    const grupos = [];
    rows.forEach((r, i) => {
      const y0 = i * rowH;
      const g = el('g', { class: 'mark' + (opts.onClick ? ' clicavel' : '') }, svg);
      el('text', { x: 0, y: y0 + 15, class: 'lbl-forte' }, g).textContent = r.label;
      el('text', { x: W, y: y0 + 15, 'text-anchor': 'end' }, g).textContent = r.right;
      el('rect', { x: 0, y: y0 + 24, width: W, height: barH, rx: 5, style: 'fill:var(--grid)' }, g);
      const segs = r.segs.filter(s => s.v > 0 && !st.hidden.has(s.key));
      const total = r.segs.reduce((s, x) => s + Math.max(0, x.v), 0) || 1;
      const gb = el('g', { class: 'gx', style: `animation-delay:${i * 70}ms` }, g);
      let x = 0;
      segs.forEach((s, j) => {
        const w = (s.v / total) * W;
        const ww = Math.max(0, w - (j < segs.length - 1 ? 2 : 0));
        const rl = j === 0 ? Math.min(5, ww / 2) : 0, rr = j === segs.length - 1 ? Math.min(5, ww / 2) : 0;
        el('path', { d: roundRow(x, y0 + 24, ww, barH, rl, rr), style: `fill:${s.color}` }, gb);
        x += w;
      });
      grupos.push({ g, r, y0 });
    });
    interact(svg, e => {
      const q = pt(svg, e, W, H);
      const h = grupos.find(h => q.y >= h.y0 && q.y < h.y0 + rowH);
      if (!h) return null;
      return {
        id: h.r.label, h, click: true,
        html: `<b>${esc(h.r.label)}</b>` + h.r.segs.map(s => tipRow(s, s.name, `${compact(s.v)} · ${pctTxt(s.v, h.r.base)}`)).join('') +
          tipRow(null, 'Contrato', brl(h.r.base)) + (opts.onClick ? '<div class="dica">Clique para abrir a obra</div>' : '')
      };
    }, {
      onEnter: it => grupos.forEach(x => x.g.classList.toggle('dim', x !== it.h)),
      onLeave: () => grupos.forEach(x => x.g.classList.remove('dim')),
      onClick: opts.onClick ? it => opts.onClick(it.h.r) : null
    });
  }

  // ---------- Colunas empilhadas ----------
  function columns(container, groups, segDefs, opts = {}) {
    const { st, anim } = estado(container, opts);
    const redraw = () => columns(container, groups, segDefs, { ...opts, animate: false });
    container.innerHTML = '';
    legend(container, segDefs, st, redraw);
    if (!groups.length) { container.insertAdjacentHTML('beforeend', '<p class="muted">Sem dados.</p>'); return; }
    const defs = segDefs.filter(d => !st.hidden.has(d.key));
    const W = Math.max(280, width(container, opts)), H = opts.height || 280;
    const m = { l: 50, r: 6, t: 14, b: 30 };
    // Valor em cima de cada coluna: na horizontal se couber, senão em pé (precisa de mais espaço no topo)
    const band0 = (W - m.l - m.r) / groups.length;
    const rotulos = opts.rotulos === false ? null : band0 >= 46 ? 'deitado' : band0 >= 11 ? 'empe' : null;
    if (rotulos === 'deitado') m.t = 22;
    if (rotulos === 'empe') m.t = 50;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const tops = groups.map(g => defs.reduce((s, d) => s + Math.max(0, g.v[d.key] || 0), 0));
    const ticks = niceTicks(0, Math.max(...tops, 1), 4);
    const ymax = ticks[ticks.length - 1];
    const Y = v => m.t + ih - (v / ymax) * ih;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.aria || 'Colunas', class: anim ? 'anim' : '' }, container);
    const hatch = hatchDef(svg);
    // Degradê vertical suave em cada cor (topo mais forte)
    const gdefs = el('defs', {}, svg), gid = 'col' + (++uid);
    const fillCol = {};
    defs.forEach((d, k) => {
      if (d.hatch) { fillCol[d.key] = hatch; return; }
      const gr = el('linearGradient', { id: `${gid}-${k}`, x1: 0, x2: 0, y1: 0, y2: 1 }, gdefs);
      el('stop', { offset: '0%', style: `stop-color:${d.color};stop-opacity:1` }, gr);
      el('stop', { offset: '100%', style: `stop-color:${d.color};stop-opacity:.72` }, gr);
      fillCol[d.key] = `url(#${gid}-${k})`;
    });
    for (const t of ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), style: `stroke:var(${t === 0 ? '--axis' : '--grid'});stroke-width:1;${t ? 'stroke-dasharray:2 4' : ''}` }, svg);
      el('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, svg).textContent = compact(t);
    }
    const band = iw / groups.length;
    const bw = Math.max(3, Math.min(34, band * 0.68));
    const every = Math.ceil(groups.length / Math.max(1, Math.floor(iw / 40)));
    const realce = el('rect', { y: m.t, height: ih, width: band, rx: 6, style: 'fill:var(--surface-2);display:none' }, svg);
    const cols = [];
    const iMax = tops.indexOf(Math.max(...tops));
    groups.forEach((g, i) => {
      const cx = m.l + band * i + band / 2;
      const gg = el('g', { class: 'mark' + (opts.onClick ? ' clicavel' : '') }, svg);
      const gy = el('g', { class: 'gy', style: `animation-delay:${Math.min(i * 25, 600)}ms` }, gg);
      let acc = 0;
      const segs = defs.filter(d => (g.v[d.key] || 0) > 0);
      segs.forEach((d, j) => {
        const v = g.v[d.key];
        const y1 = Y(acc), isTop = j === segs.length - 1;
        const hgt = Math.max(0, y1 - Y(acc + v) - (isTop ? 0 : 2));
        const r = isTop ? Math.min(5, bw / 2, hgt) : 0;
        el('path', { d: roundTop(cx - bw / 2, y1 - hgt, bw, hgt, r), style: `fill:${fillCol[d.key]};${d.hatch ? 'stroke:var(--ink-2);stroke-width:1' : ''}` }, gy);
        acc += v;
      });
      if (i % every === 0) el('text', { x: cx, y: H - m.b + 18, 'text-anchor': 'middle' }, svg).textContent = g.short || g.label;
      cols.push({ gg, g, i });
    });
    if (rotulos) {
      groups.forEach((g, i) => {
        if (!(tops[i] > 0)) return;
        const cx = m.l + band * i + band / 2, y = Y(tops[i]) - 5;
        const t = rotulos === 'deitado'
          ? el('text', { x: cx, y, 'text-anchor': 'middle', class: 'lbl rot' }, svg)
          : el('text', { x: cx + 3.5, y, 'text-anchor': 'start', transform: `rotate(-90 ${cx + 3.5} ${y})`, class: 'lbl rot' }, svg);
        t.textContent = compact(tops[i]);
      });
    } else if (tops[iMax] > 0 && opts.rotuloMax !== false) {
      const cx = m.l + band * iMax + band / 2;
      el('text', { x: cx, y: Y(tops[iMax]) - 5, 'text-anchor': 'middle', class: 'lbl' }, svg).textContent = compact(tops[iMax]);
    }
    interact(svg, e => {
      const q = pt(svg, e, W, H);
      const c = cols[Math.floor((q.x - m.l) / band)];
      if (!c || q.y > H - m.b + 4) return null;
      const g = c.g, total = defs.reduce((s, d) => s + (g.v[d.key] || 0), 0);
      return {
        id: g.label, c, click: true,
        html: `<b>${esc(g.label)}${g.sub ? ' · ' + esc(g.sub) : ''}</b>` +
          defs.filter(d => g.v[d.key]).map(d => tipRow(d, d.name, brl(g.v[d.key]))).join('') +
          tipRow(null, 'Total', brl(total)) + (g.extra || '') + (opts.onClick ? '<div class="dica">Clique para ver os lançamentos</div>' : '')
      };
    }, {
      onEnter: it => {
        cols.forEach(x => x.gg.classList.toggle('dim', x !== it.c));
        realce.setAttribute('x', m.l + band * it.c.i); realce.style.display = '';
      },
      onLeave: () => { cols.forEach(x => x.gg.classList.remove('dim')); realce.style.display = 'none'; },
      onClick: opts.onClick ? it => opts.onClick(it.c.g) : null
    });
  }

  // ---------- Linhas acumuladas ----------
  function lines(container, labels, series, opts = {}) {
    const { st, anim } = estado(container, opts);
    const redraw = () => lines(container, labels, series, { ...opts, animate: false });
    container.innerHTML = '';
    legend(container, series.map(s => ({ ...s, line: true })), st, redraw);
    const vis = series.filter(s => !st.hidden.has(s.key));
    const W = Math.max(280, width(container, opts)), H = opts.height || 280;
    const endLabels = W > 520;
    const m = { l: 50, r: endLabels ? 96 : 10, t: 16, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const all = vis.flatMap(s => s.values.filter(v => v != null));
    if (opts.ref) all.push(opts.ref.value);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(...all, 1), 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const Y = v => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
    const n = labels.length;
    const X = i => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.aria || 'Linhas' }, container);
    const defs = el('defs', {}, svg);
    const clipId = 'clip' + (++uid), gradId = 'grad' + uid;
    const clipRect = el('rect', { x: 0, y: 0, width: anim ? 0 : W, height: H }, el('clipPath', { id: clipId }, defs));
    if (anim) el('animate', { attributeName: 'width', from: 0, to: W, dur: '1.1s', fill: 'freeze', calcMode: 'spline', keySplines: '.2 .7 .2 1', keyTimes: '0;1' }, clipRect);
    // Uma área em degradê da cor de cada série
    const gradOf = (color, k) => {
      const grad = el('linearGradient', { id: gradId + '-' + k, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
      el('stop', { offset: '0%', style: `stop-color:${color};stop-opacity:.22` }, grad);
      el('stop', { offset: '100%', style: `stop-color:${color};stop-opacity:0` }, grad);
      return `url(#${gradId}-${k})`;
    };

    for (const t of ticks) {
      el('line', { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), style: `stroke:var(${t === 0 ? '--axis' : '--grid'});stroke-width:1;${t ? 'stroke-dasharray:2 4' : ''}` }, svg);
      el('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, svg).textContent = compact(t);
    }
    const every = Math.ceil(n / Math.max(1, Math.floor(iw / 44)));
    labels.forEach((l, i) => { if (!(i % every)) el('text', { x: X(i), y: H - m.b + 18, 'text-anchor': 'middle' }, svg).textContent = l; });
    if (opts.ref) {
      el('line', { x1: m.l, x2: m.l + iw, y1: Y(opts.ref.value), y2: Y(opts.ref.value), style: 'stroke:var(--ink-2);stroke-width:1.2;stroke-dasharray:6 5' }, svg);
      el('text', { x: m.l + 6, y: Y(opts.ref.value) - 6, class: 'lbl' }, svg).textContent = `${opts.ref.label} ${compact(opts.ref.value)}`;
    }
    const plot = el('g', { 'clip-path': `url(#${clipId})` }, svg);
    const ends = [];
    vis.forEach((s, k) => {
      let d = '', pen = false, last = null, first = null;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)} `;
        pen = true; last = i; if (first == null) first = i;
      });
      if (k === 0 && first != null) el('path', { d: `${d} L${X(last)},${Y(Math.max(0, y0))} L${X(first)},${Y(Math.max(0, y0))} Z`, style: `fill:${gradOf(s.color, k)}` }, plot);
      el('path', { d, style: `fill:none;stroke:${s.color};stroke-width:${s.width || 2.2};stroke-linejoin:round;stroke-linecap:round;${s.dash ? 'stroke-dasharray:' + s.dash : ''}` }, plot);
      if (last != null) {
        el('circle', { cx: X(last), cy: Y(s.values[last]), r: 4, style: `fill:${s.color};stroke:var(--surface);stroke-width:2` }, plot);
        ends.push({ s, y: Y(s.values[last]) });
      }
    });
    if (endLabels) {
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
      for (const e of ends) el('text', { x: m.l + iw + 10, y: e.y + 4, class: 'lbl' }, svg).textContent = e.s.name;
    }
    const cross = el('line', { y1: m.t, y2: m.t + ih, style: 'stroke:var(--laranja);stroke-width:1.5;stroke-dasharray:3 3;display:none' }, svg);
    const dots = vis.map(s => el('circle', { r: 5, style: `fill:${s.color};stroke:var(--surface);stroke-width:2;display:none` }, svg));
    interact(svg, e => {
      const q = pt(svg, e, W, H);
      const i = Math.round(n <= 1 ? 0 : ((q.x - m.l) / iw) * (n - 1));
      if (i < 0 || i >= n) return null;
      return {
        id: i, i,
        html: `<b>${esc(opts.tipTitle ? opts.tipTitle(i) : labels[i])}</b>` + vis.map(s => tipRow({ color: s.color }, s.name, brl(s.values[i]))).join('') +
          (opts.ref ? tipRow(null, opts.ref.label, brl(opts.ref.value)) : '')
      };
    }, {
      onEnter: it => {
        cross.setAttribute('x1', X(it.i)); cross.setAttribute('x2', X(it.i)); cross.style.display = '';
        vis.forEach((s, k) => {
          const v = s.values[it.i];
          dots[k].style.display = v == null ? 'none' : '';
          if (v != null) { dots[k].setAttribute('cx', X(it.i)); dots[k].setAttribute('cy', Y(v)); }
        });
      },
      onLeave: () => { cross.style.display = 'none'; dots.forEach(d => { d.style.display = 'none'; }); }
    });
  }

  return { donut, stackBars, columns, lines, compact, brl, esc };
})();
