const SwingProjection = (() => {
  // Repair a known motion by solving for each control and intermediate state.
  // Fixed endpoints leave a block-tridiagonal normal system, with 6×6 blocks.
  const N = 6;
  const stateScale = [0.65, 1, 1, 2, 2, 2];
  const controlScale = 2;
  const residualScale = [2, 1, 1, 0.4, 0.18, 0.18];
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const difference = (a, b) => a.map((x, i) => x - b[i]);
  const transpose = a => a[0].map((_, i) => a.map(row => row[i]));
  const multiply = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, x, i) => sum + x * b[i][j], 0)));
  const multiplyVector = (a, b) => a.map(row => dot(row, b));
  const identity = Array.from({length: N}, (_, i) => Array.from({length: N}, (_, j) => Number(i === j)));

  function transition(z, u, count) {
    for (let i = 0; i < count; i++) z = Plant.step(z, u, 0.005);
    return z;
  }

  function linearize(z, u, count) {
    const columns = [];
    for (let i = 0; i <= N; i++) {
      const h = 1e-5;
      const plus = z.slice(), minus = z.slice();
      if (i < N) { plus[i] += h; minus[i] -= h; }
      const f1 = transition(plus, u + (i === N ? h : 0), count);
      const f2 = transition(minus, u - (i === N ? h : 0), count);
      columns.push(difference(f1, f2).map(x => x / (2 * h) * (i === N ? controlScale : stateScale[i])));
    }
    return transpose(columns);
  }

  function solve(a, b) {
    const rows = a.map((row, i) => row.concat(b[i]));
    for (let j = 0; j < N; j++) {
      let pivot = j;
      for (let i = j + 1; i < N; i++) if (Math.abs(rows[i][j]) > Math.abs(rows[pivot][j])) pivot = i;
      if (pivot !== j) [rows[j], rows[pivot]] = [rows[pivot], rows[j]];
      const diagonal = rows[j][j];
      if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-13) return null;
      for (let k = j; k < rows[j].length; k++) rows[j][k] /= diagonal;
      for (let i = 0; i < N; i++) if (i !== j) {
        const coefficient = rows[i][j];
        for (let k = j; k < rows[i].length; k++) rows[i][k] -= coefficient * rows[j][k];
      }
    }
    return rows.map(row => row.slice(N));
  }

  function correction(model, defects) {
    const steps = model.length;
    const offset = [], link = [];
    const lower = d => d.map(row => row.slice(0, N).map((x, j) => -x * stateScale[j]));
    for (let i = 0; i < steps; i++) {
      const d = model[i];
      let diagonal = d.map((row, j) => d.map((other, k) =>
        (i > 0 ? dot(row.slice(0, N), other.slice(0, N)) : 0)
        + (i + 1 < steps ? identity[j][k] * stateScale[j] ** 2 : 0)
        + row[N] * other[N] + identity[j][k] * 1e-11));
      let residual = defects[i];
      if (i > 0) {
        const below = lower(d);
        const block = multiply(below, link[i - 1]);
        diagonal = diagonal.map((row, j) => difference(row, block[j]));
        residual = difference(residual, multiplyVector(below, offset[i - 1]));
      }
      const above = i + 1 < steps ? transpose(lower(model[i + 1])) : identity.map(row => row.map(() => 0));
      const result = solve(diagonal, above.map((row, j) => row.concat(residual[j])));
      if (!result) return null;
      offset.push(result.map(row => row[N]));
      link.push(result.map(row => row.slice(0, N)));
    }
    for (let i = steps - 2; i >= 0; i--) offset[i] = difference(offset[i], multiplyVector(link[i], offset[i + 1]));
    const dz = [Array(N).fill(0)], du = [];
    for (let i = 0; i < steps; i++) {
      const d = transpose(model[i]);
      du.push(-dot(d[N], offset[i]) * controlScale);
      if (i > 0) dz.push(d.slice(0, N).map((row, j) =>
        (offset[i - 1][j] * stateScale[j] - dot(row, offset[i])) * stateScale[j]));
    }
    dz.push(Array(N).fill(0));
    return {dz, du};
  }

  function assessment(states, controls, count) {
    const defects = controls.map((u, i) => difference(transition(states[i], u, count), states[i + 1]));
    const peak = defects.reduce((best, row) => Math.max(best, ...row.map(Math.abs)), 0);
    let loss = defects.reduce((total, row) => total + row.reduce((sum, x, i) => sum + (x * residualScale[i]) ** 2, 0), 0);
    const rail = Plant.params.railLimit;
    for (let i = 1; i + 1 < states.length; i++) loss += 80 * Math.max(0, Math.abs(states[i][0]) - (rail - 0.07)) ** 2;
    return {defects, peak, loss};
  }

  function* repair(start, target, dt, nominalControls, nominalStart) {
    const count = Math.round(dt / 0.005);
    if (!count || !nominalStart || !nominalControls.length) return null;
    let controls = nominalControls.slice();
    let states = [nominalStart];
    for (const u of controls) states.push(transition(states.at(-1), u, count));
    if (states.some(row => row.some(x => !Number.isFinite(x)))) return null;
    const left = start[0] - states[0][0], right = target[0] - states.at(-1)[0];
    const duration = dt * controls.length;
    states = states.map((row, i) => {
      const s = i / controls.length;
      const shifted = row.slice();
      shifted[0] += left + (right - left) * s ** 2 * (3 - 2 * s);
      shifted[3] += (right - left) * 6 * s * (1 - s) / duration;
      return shifted;
    });
    states[0] = start;
    states[states.length - 1] = target;
    let score = assessment(states, controls, count);
    const limit = Plant.params.forceLimit - 0.8;
    const maxIterations = 12;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (!Number.isFinite(score.loss)) return null;
      if (score.peak < 2e-12) return controls;
      yield {iteration, budget: maxIterations};
      const model = controls.map((u, i) => linearize(states[i], u, count));
      const delta = correction(model, score.defects);
      if (!delta) return null;
      let accepted = false;
      for (const fraction of [1, 0.6, 0.3, 0.12, 0.04]) {
        const trialStates = states.map((row, i) => row.map((x, j) => x + fraction * delta.dz[i][j]));
        const trialControls = controls.map((u, i) => Math.max(-limit, Math.min(limit, u + fraction * delta.du[i])));
        const trialScore = assessment(trialStates, trialControls, count);
        if (trialScore.loss < score.loss) {
          controls = trialControls;
          states = trialStates;
          score = trialScore;
          accepted = true;
          break;
        }
      }
      if (!accepted) break;
    }
    return score.peak < 1e-7 ? controls : null;
  }

  return {repair};
})();
