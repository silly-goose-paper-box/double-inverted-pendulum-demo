const Visuals = (() => {
  const palette = Object.freeze({
    background: '#101a26',
    chart: '#101821',
    grid: '#213041',
    gridMinor: '#192635',
    baseline: '#36485e',
    frame: '#34475b',
    text: '#edf4ff',
    muted: '#9daec1',
    teal: '#54dfc8',
    amber: '#f2b86d',
    reference: '#92a2e0',
    blue: '#82aafc',
    cart: '#a5b6ca',
    cartTop: '#d0dfed',
    cartDark: '#52647c',
    wheel: '#29384a',
    rail: '#71839a',
    force: '#f184ad'
  });
  const mono = '"IBM Plex Mono", Consolas, monospace';
  const sans = 'Inter, "Microsoft YaHei UI", "PingFang SC", sans-serif';
  const degrees = 180 / Math.PI;
  const angleDegrees = angle => ((angle * degrees + 180) % 360 + 360) % 360 - 180;
  const plotSpecs = {
    position: { minimum: 0.4, lines: [
      { color: 'blue', value: p => p.z[0] },
      { color: 'reference', dashed: true, value: p => p.ref }
    ] },
    angles: { minimum: 8, lines: [
      { color: 'teal', value: p => angleDegrees(p.z[1]), jump: 180 },
      { color: 'amber', value: p => angleDegrees(p.z[2]), jump: 180 }
    ] },
    velocity: { minimum: 0.25, lines: [
      { color: 'blue', value: p => p.z[3] }
    ] },
    angularVelocity: { minimum: 15, lines: [
      { color: 'teal', value: p => p.z[4] * degrees },
      { color: 'amber', value: p => p.z[5] * degrees }
    ] },
    force: { minimum: 5, lines: [
      { color: 'force', value: p => p.u }
    ] }
  };

  function surface(canvas) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width < 2 || bounds.height < 2) return null;
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
      const width = Math.round(bounds.width * ratio);
      const height = Math.round(bounds.height * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.setTransform(width / bounds.width, 0, 0, height / bounds.height, 0, 0);
      return { ctx, width: bounds.width, height: bounds.height };
    };
  }

  function segment(ctx, x0, y0, x1, y1, color, width = 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function dot(ctx, x, y, radius, color, outline) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function label(ctx, value, x, y, { color = palette.muted, align = 'left', size = 11, family = mono } = {}) {
    ctx.font = `${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(value, x, y);
  }

  function rectangle(ctx, x, y, width, height, radius, color, outline) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = color;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function grid(ctx, width, height, originX, originY, spacing) {
    for (let i = Math.ceil(-originX / spacing); i <= Math.floor((width - originX) / spacing); i++) {
      const x = Math.round(originX + i * spacing) + 0.5;
      segment(ctx, x, 0, x, height, i % 4 === 0 ? palette.grid : palette.gridMinor);
    }
    for (let i = Math.ceil(-originY / spacing); i <= Math.floor((height - originY) / spacing); i++) {
      const y = Math.round(originY + i * spacing) + 0.5;
      segment(ctx, 0, y, width, y, i % 4 === 0 ? palette.grid : palette.gridMinor);
    }
  }

  function drawRod(ctx, from, to, color, width) {
    ctx.lineCap = 'round';
    segment(ctx, from.x, from.y, to.x, to.y, palette.chart, width + 5);
    segment(ctx, from.x, from.y, to.x, to.y, color, width);
    ctx.lineCap = 'butt';
  }

  function drawTrack(ctx, originX, railY, meters, railLimit) {
    const left = originX - railLimit * meters;
    const right = originX + railLimit * meters;
    segment(ctx, left, railY + 5, right, railY + 5, palette.cartDark, 1);
    segment(ctx, left, railY, right, railY, palette.rail, 2);
    for (const x of [left, right]) {
      segment(ctx, x, railY - 7, x, railY + 7, palette.rail, 2);
    }
    for (let tick = Math.ceil(-railLimit * 2); tick <= Math.floor(railLimit * 2); tick++) {
      const x = originX + tick * meters / 2;
      const major = tick % 2 === 0;
      segment(ctx, x, railY + 9, x, railY + (major ? 17 : 13), major ? palette.rail : palette.baseline);
      if (major) label(ctx, String(tick / 2), x, railY + 26, { align: 'center', size: 10 });
    }
    label(ctx, 'x (m)', right, railY + 26, { align: 'right', size: 10 });
  }

  function drawTarget(ctx, x, railY, top) {
    ctx.setLineDash([4, 5]);
    segment(ctx, x, top, x, railY - 5, palette.reference);
    ctx.setLineDash([]);
    ctx.fillStyle = palette.reference;
    ctx.beginPath();
    ctx.moveTo(x, railY - 1);
    ctx.lineTo(x - 5, railY + 7);
    ctx.lineTo(x + 5, railY + 7);
    ctx.closePath();
    ctx.fill();
  }

  function drawCart(ctx, x, railY, width) {
    const wheelRadius = width > 54 ? 7 : 5;
    const wheelY = railY - wheelRadius;
    for (const wheelX of [x - width * 0.29, x + width * 0.29]) {
      dot(ctx, wheelX, wheelY, wheelRadius, palette.wheel, palette.rail);
      dot(ctx, wheelX, wheelY, 1.5, palette.cartTop);
    }
    const height = width > 54 ? 22 : 18;
    const top = wheelY - height - 1;
    rectangle(ctx, x - width / 2, top, width, height, 4, palette.cart, palette.cartTop);
    rectangle(ctx, x - width / 2 + 5, top + height - 6, width - 10, 2, 1, palette.cartDark);
    return { x, y: top - 2 };
  }

  function drawForce(ctx, x, y, u, maxForce, width) {
    if (!Number.isFinite(u) || Math.abs(u) < 0.08) return;
    const sign = Math.sign(u);
    const length = 12 + 62 * Math.min(Math.abs(u) / maxForce, 1);
    const end = Math.max(13, Math.min(width - 13, x + length * sign));
    if ((end - x) * sign < 6) return;
    segment(ctx, x, y, end, y, palette.force, 1.8);
    segment(ctx, end - 5 * sign, y - 4, end, y, palette.force, 1.8);
    segment(ctx, end - 5 * sign, y + 4, end, y, palette.force, 1.8);
  }

  function drawScene(frame, z, ref, u, params) {
    const { ctx, width, height } = frame;
    const originX = width / 2;
    const railY = Math.round(height * 0.71) + 0.5;
    if (width < 100 || height < 100) return;
    const meters = Math.min((width - 56) / (2 * params.railLimit), (height - railY + 10) / (params.L1 + params.L2));
    const x = originX + z[0] * meters;
    const cartWidth = Math.min(66, Math.max(36, meters * 0.53));
    const legendY = height > 200 ? 21 : 15;

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
    grid(ctx, width, height, originX, railY, Math.max(15, meters / 4));
    segment(ctx, 0, railY + 43, width, railY + 43, palette.grid);
    drawTrack(ctx, originX, railY, meters, params.railLimit);
    const markerTop = Math.max(legendY + 15, railY - (params.L1 + params.L2) * meters - 56);
    drawTarget(ctx, originX + ref * meters, railY, markerTop);
    const pivot = drawCart(ctx, x, railY, cartWidth);
    const joint = {
      x: pivot.x + params.L1 * meters * Math.sin(z[1]),
      y: pivot.y - params.L1 * meters * Math.cos(z[1])
    };
    const tip = {
      x: joint.x + params.L2 * meters * Math.sin(z[2]),
      y: joint.y - params.L2 * meters * Math.cos(z[2])
    };

    drawForce(ctx, x + Math.sign(u) * (cartWidth / 2 + 4), pivot.y + 9, u, params.forceLimit, width);
    drawRod(ctx, pivot, joint, palette.teal, 7);
    drawRod(ctx, joint, tip, palette.amber, 6);
    dot(ctx, pivot.x, pivot.y, 5.4, palette.chart, palette.cartTop);
    dot(ctx, pivot.x, pivot.y, 1.7, palette.teal);
    dot(ctx, joint.x, joint.y, 5, palette.chart, palette.amber);
    dot(ctx, joint.x, joint.y, 1.5, palette.cartTop);
    dot(ctx, tip.x, tip.y, 4, palette.amber, palette.background);

    const legend = [
      { text: '下杆', color: palette.teal },
      { text: '上杆', color: palette.amber },
      { text: '目标位置', color: palette.reference, dashed: true }
    ];
    let legendX = 17;
    for (const item of legend) {
      if (item.dashed) ctx.setLineDash([3, 3]);
      segment(ctx, legendX, legendY, legendX + 11, legendY, item.color, 2);
      ctx.setLineDash([]);
      label(ctx, item.text, legendX + 16, legendY, { family: sans });
      legendX += 56;
    }
    if (height > 240 && width >= 360) {
      label(ctx, `行程 ±${params.railLimit.toFixed(1)} m`, width - 16, height - 19, { align: 'right', family: sans });
    }
  }

  function niceStep(target) {
    const base = 10 ** Math.floor(Math.log10(target));
    const ratio = target / base;
    for (const multiple of [1, 2, 2.5, 5, 10]) {
      if (ratio <= multiple) return multiple * base;
    }
    return 10 * base;
  }

  function tickText(value, step) {
    let digits = 0;
    let scaled = step;
    while (Math.abs(Math.round(scaled) - scaled) > 1e-8 && digits < 4) {
      digits++;
      scaled *= 10;
    }
    const normalized = Math.abs(value) < step / 100 ? 0 : value;
    return normalized.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  function plotBounds(history, spec, start, memory, endTime) {
    let maximum = spec.minimum;
    for (const point of history) {
      if (point.t < start) continue;
      for (const line of spec.lines) {
        const value = line.value(point);
        if (Number.isFinite(value)) maximum = Math.max(maximum, Math.abs(value) * 1.08);
      }
    }
    const nextStep = niceStep(maximum / 2);
    if (!memory.step || endTime < memory.time || nextStep > memory.step || nextStep * 2 <= memory.step) {
      memory.step = nextStep;
    }
    memory.time = endTime;
    return memory.step;
  }

  function plotTrace(ctx, line, history, mapX, mapY, start, end, endTime) {
    ctx.strokeStyle = palette[line.color];
    ctx.lineWidth = line.dashed ? 1.15 : 1.9;
    ctx.lineJoin = 'round';
    if (line.dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let penDown = false;
    let last = null;
    let previousValue;
    for (let i = 0; i < history.length; i++) {
      const point = history[i];
      if (point.t < start && (i === history.length - 1 || history[i + 1].t < start)) continue;
      if (point.t > end) break;
      const value = line.value(point);
      if (!Number.isFinite(value)) {
        penDown = false;
        continue;
      }
      const x = mapX(point.t);
      const y = mapY(value);
      if (penDown && (!line.jump || Math.abs(value - previousValue) <= line.jump)) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
      previousValue = value;
      if (point.t >= start && point.t === endTime) last = { x, y };
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (last && !line.dashed) dot(ctx, last.x, last.y, 2.5, palette[line.color]);
  }

  function drawPlot(frame, history, spec, options, memory) {
    const { ctx, width, height } = frame;
    ctx.fillStyle = palette.chart;
    ctx.fillRect(0, 0, width, height);
    if (width < 95 || height < 67) return;

    const windowSeconds = Number.isFinite(options.windowSeconds) && options.windowSeconds > 0 ? options.windowSeconds : 12;
    const endTime = history.at(-1)?.t ?? 0;
    const end = Math.max(windowSeconds, endTime);
    const start = end - windowSeconds;
    const step = plotBounds(history, spec, start, memory, endTime);
    const upper = 2 * step;
    const top = 10.5;
    const bottom = height - 23.5;
    const left = width > 170 ? 48.5 : 38.5;
    const right = width - 12.5;
    const mapX = time => left + (time - start) / windowSeconds * (right - left);
    const mapY = value => top + (upper - value) / (2 * upper) * (bottom - top);
    const timeStep = niceStep(windowSeconds / Math.max(2, Math.floor((right - left) / 57)));

    for (let tick = -2; tick <= 2; tick++) {
      if (bottom - top < 62 && Math.abs(tick) === 1) continue;
      const value = tick * step;
      const y = Math.round(mapY(value)) + 0.5;
      segment(ctx, left, y, right, y, tick === 0 ? palette.baseline : palette.grid);
      label(ctx, tickText(value, step), left - 7, y, { align: 'right', size: 10 });
    }
    for (let tick = Math.ceil((start - 1e-9) / timeStep); tick * timeStep <= end + 1e-9; tick++) {
      const value = tick * timeStep;
      const x = Math.round(mapX(value)) + 0.5;
      segment(ctx, x, top, x, bottom, palette.grid);
      if (x < right - 19) label(ctx, tickText(value, timeStep), x, height - 10.5, { align: 'center', size: 10 });
    }
    segment(ctx, left, top, left, bottom, palette.frame);
    segment(ctx, right, top, right, bottom, palette.frame);
    label(ctx, 't (s)', right, height - 10.5, { align: 'right', size: 10 });

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    for (const line of spec.lines) plotTrace(ctx, line, history, mapX, mapY, start, end, endTime);
    ctx.restore();
  }

  function create({ scene, plots, params }) {
    const sceneSurface = surface(scene);
    const chartSurfaces = Object.entries(plotSpecs).map(([name, spec]) => ({
      frame: surface(plots[name]), spec, memory: { step: 0, time: 0 }
    })).filter(chart => chart.frame);
    const plantParams = params ?? Plant.params;
    return {
      drawScene(z, ref, u) {
        const frame = sceneSurface?.();
        if (frame && z.every(Number.isFinite)) drawScene(frame, z, ref, u, plantParams);
      },
      drawPlots(history, options = {}) {
        for (const chart of chartSurfaces) {
          const frame = chart.frame();
          if (frame) drawPlot(frame, history, chart.spec, options, chart.memory);
        }
      }
    };
  }

  return { create, palette };
})();
