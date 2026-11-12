const SwingPlanner = (() => {
  const N = 6;
  const samplePeriod = 0.01;
  const physicsPeriod = 0.005;
  const planLimit = Plant.params.forceLimit - 0.8;
  const rail = Plant.params.railLimit;
  const localLimits = [0.10, 0.10, 0.45, 0.65, 0.75];
  const matrix = () => Array.from({length: N}, () => Array(N).fill(0));
  const zero = () => Array(N).fill(0);
  const diagonal = values => values.map((value, i) => values.map((_, j) => i === j ? value : 0));
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const clip = (value, limit) => Math.max(-limit, Math.min(limit, value));
  const clearance = z => Math.min(0.04, (rail - Math.abs(z[0])) / 2);
  const wrap = theta => {
    const tau = 2 * Math.PI;
    return ((theta + Math.PI) % tau + tau) % tau - Math.PI;
  };

  function principalState(z) {
    return [z[0], wrap(z[1]), wrap(z[2]), z[3], z[4], z[5]];
  }

  function error(z, reference, periodic) {
    const difference = z.map((value, i) => value - reference[i]);
    if (periodic) {
      difference[1] = wrap(difference[1]);
      difference[2] = wrap(difference[2]);
    }
    return difference;
  }

  function integrate(z, u, steps) {
    let state = z;
    for (let i = 0; i < steps; i++) state = Plant.step(state, u, physicsPeriod);
    return state;
  }

  function viableObstruction(z, maxForce = Plant.params.forceLimit) {
    const {totalMass, p1, p2} = Plant.constants;
    const {b} = Plant.params;
    const p = totalMass * z[3] + p1 * Math.cos(z[1]) * z[4] + p2 * Math.cos(z[2]) * z[5];
    const y = totalMass * z[0] + p1 * Math.sin(z[1]) + p2 * Math.sin(z[2]);
    const yMax = totalMass * rail + p1 + p2;
    for (const direction of [-1, 1]) {
      const momentum = direction * p - b * (rail - direction * z[0]);
      if (momentum <= 0) continue;
      const bound = momentum * momentum / (2 * maxForce);
      if (bound > yMax - direction * y + 1e-9) {
        return {time: momentum / maxForce, direction, bound, room: yMax - direction * y};
      }
    }
    return null;
  }

  function derivative(z, u, steps) {
    const A = matrix();
    for (let j = 0; j < N; j++) {
      const h = 1e-5 * Math.max(1, Math.abs(z[j]));
      const plus = z.slice();
      const minus = z.slice();
      plus[j] += h;
      minus[j] -= h;
      const fPlus = integrate(plus, u, steps);
      const fMinus = integrate(minus, u, steps);
      for (let i = 0; i < N; i++) A[i][j] = (fPlus[i] - fMinus[i]) / (2 * h);
    }
    const du = 1e-4;
    const fPlus = integrate(z, u + du, steps);
    const fMinus = integrate(z, u - du, steps);
    return {A, B: fPlus.map((value, i) => (value - fMinus[i]) / (2 * du))};
  }

  function quadratic(A, B, V) {
    const VA = matrix();
    const VB = zero();
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < N; k++) {
        const v = V[i][k];
        VB[i] += v * B[k];
        for (let j = 0; j < N; j++) VA[i][j] += v * A[k][j];
      }
    }
    const AA = matrix();
    const BA = zero();
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < N; k++) {
        BA[i] += B[k] * VA[k][i];
        for (let j = i; j < N; j++) AA[i][j] += A[k][i] * VA[k][j];
      }
    }
    for (let i = 1; i < N; i++) for (let j = 0; j < i; j++) AA[i][j] = AA[j][i];
    return {AA, BA, BB: dot(B, VB)};
  }

  const runningWeights = [0.10, 0.018, 0.016, 0.019, 0.0012, 0.0012];
  const endWeights = [110, 320, 340, 38, 26, 23];
  const forceWeight = 0.0015;

  function stage(z, u, target, dt) {
    const e = error(z, target, false);
    const boundary = Math.max(0, Math.abs(z[0]) - (rail - 0.48));
    const cost = 0.5 * dt * (dot(e, e.map((value, i) => value * runningWeights[i]))
      + forceWeight * u * u + 1400 * boundary * boundary);
    const gradient = e.map((value, i) => value * runningWeights[i] * dt);
    gradient[0] += 1400 * dt * boundary * Math.sign(z[0]);
    const weights = runningWeights.map(value => value * dt);
    if (boundary > 0) weights[0] += 1400 * dt;
    return {cost, gradient, weights};
  }

  function terminal(z, target) {
    const e = error(z, target, false);
    return 0.5 * dot(e, e.map((value, i) => value * endWeights[i]));
  }

  function roll(start, controls, target, steps, dt, base, policy, alpha) {
    const states = [start];
    const commands = [];
    let z = start;
    let cost = 0;
    let peak = Math.abs(z[0]);
    for (let i = 0; i < controls.length; i++) {
      const correction = policy ? alpha * policy[i].k + dot(policy[i].K, error(z, base.states[i], false)) : 0;
      const u = clip(controls[i] + correction, planLimit);
      cost += stage(z, u, target, dt).cost;
      z = integrate(z, u, steps);
      if (z.some(value => !Number.isFinite(value) || Math.abs(value) > 1e4)) {
        return {cost: Infinity, states, commands, peak: Infinity};
      }
      peak = Math.max(peak, Math.abs(z[0]));
      states.push(z);
      commands.push(u);
    }
    return {states, commands, peak, cost: cost + terminal(z, target)};
  }

  function backward(rollout, target, dt, derivatives, regularization) {
    let V = diagonal(endWeights);
    let v = error(rollout.states.at(-1), target, false).map((value, i) => value * endWeights[i]);
    const policy = Array(rollout.commands.length);
    for (let i = rollout.commands.length - 1; i >= 0; i--) {
      const {A, B} = derivatives[i];
      const {AA, BA, BB} = quadratic(A, B, V);
      const u = rollout.commands[i];
      const {gradient, weights} = stage(rollout.states[i], u, target, dt);
      const Quu = forceWeight * dt + BB + regularization;
      if (!(Quu > 1e-10) || !Number.isFinite(Quu)) return null;
      const Qu = forceWeight * dt * u + dot(B, v);
      const k = Math.max(-planLimit - u, Math.min(planLimit - u, -Qu / Quu));
      const free = Math.abs(u + k) < planLimit - 1e-7;
      const K = free ? BA.map(value => -value / Quu) : zero();
      const nextV = matrix();
      const nextv = zero();
      for (let a = 0; a < N; a++) {
        let Qx = gradient[a];
        for (let j = 0; j < N; j++) Qx += A[j][a] * v[j];
        nextv[a] = Qx + BA[a] * k;
        for (let b = 0; b < N; b++) {
          nextV[a][b] = AA[a][b] + (a === b ? weights[a] : 0)
            - (free ? BA[a] * BA[b] / Quu : 0);
        }
      }
      policy[i] = {k, K};
      v = nextv;
      V = nextV;
    }
    return policy;
  }

  const makeLqr = () => Control.build("lqr");

  function captureCanSettle(z, ref, margin, regulator, t, applied) {
    if (margin <= 0) return null;
    let state = z;
    let peak = Math.abs(state[0]);
    for (let i = 0; i < 5 / samplePeriod; i++) {
      const command = regulator.run({z: principalState(state), ref, dt: samplePeriod, t: t + i * samplePeriod, applied});
      if (!Number.isFinite(command)) return null;
      const u = clip(command, Plant.params.forceLimit);
      applied = u;
      const half = integrate(state, u, 1);
      state = integrate(half, u, 1);
      if (state.some(value => !Number.isFinite(value))) return null;
      peak = Math.max(peak, Math.abs(half[0]), Math.abs(state[0]));
      if (peak > rail - margin) return null;
    }
    const final = principalState(state);
    if (Math.abs(final[0] - ref) > 0.018 || final.slice(1).some(value => Math.abs(value) > 0.025)) return null;
    return {peak, final};
  }

  function localCandidate(state, ref, checkCapture) {
    const z = principalState(state);
    if (z.slice(1).some((value, index) => Math.abs(value) > localLimits[index])) return null;
    const check = checkCapture(z, ref, clearance(z), 0, 0);
    if (!check) return null;
    return {trajectory: [], travel: check.peak, peakForce: 0, seconds: 0, target: ref};
  }

  function trackingGains(samples, commands) {
    const weights = [4, 22, 22, 1.2, 0.36, 0.36];
    const rho = 0.65;
    let V = diagonal([150, 260, 260, 35, 21, 21]);
    const gains = Array(commands.length);
    for (let i = commands.length - 1; i >= 0; i--) {
      const {A, B} = derivative(samples[i], commands[i], 2);
      const {AA, BA, BB} = quadratic(A, B, V);
      const divisor = rho + BB;
      gains[i] = BA.map(value => value / divisor);
      V = AA.map((row, j) => row.map((value, k) => value + (j === k ? weights[j] : 0)
        - BA[j] * BA[k] / divisor));
    }
    return gains;
  }

  function verifyPlan(start, controls, dt, ref, checkCapture = checkLqrCapture) {
    const subdivisions = Math.round(dt / samplePeriod);
    const margin = clearance(start);
    if (margin <= 0 || !Number.isInteger(subdivisions) || subdivisions < 1 ||
        controls.some(u => !Number.isFinite(u) || Math.abs(u) > Plant.params.forceLimit)) return null;
    const samples = [];
    const commands = [];
    let state = start;
    let travel = Math.abs(state[0]);
    let peakForce = 0;
    for (const u of controls) {
      for (let j = 0; j < subdivisions; j++) {
        samples.push(state);
        commands.push(u);
        const half = integrate(state, u, 1);
        state = integrate(half, u, 1);
        if (state.some(value => !Number.isFinite(value))) return null;
        travel = Math.max(travel, Math.abs(half[0]), Math.abs(state[0]));
        peakForce = Math.max(peakForce, Math.abs(u));
        if (travel > rail - margin) return null;
      }
    }
    const principal = principalState(state);
    if (Math.abs(principal[0] - ref) > 0.28 || principal.slice(1).some((value, i) => Math.abs(value) > localLimits[i] * 0.85)) return null;
    const seconds = commands.length * samplePeriod;
    const checked = checkCapture(state, ref, margin, seconds, commands.at(-1) ?? 0);
    if (!checked) return null;
    const gains = trackingGains(samples, commands);
    return {
      trajectory: commands.map((u, i) => ({z: samples[i], u, K: gains[i]})),
      travel: Math.max(travel, checked.peak),
      peakForce,
      seconds,
      target: ref,
    };
  }

  function closeToTarget(z, target, multiplier) {
    const e = error(z, target, false);
    return Math.abs(e[0]) <= 0.28 * multiplier
      && e.slice(1).every((value, i) => Math.abs(value) <= localLimits[i] * multiplier);
  }

  function* improve(start, ref, target, seed, budget, iterationLabel, checkCapture) {
    const dt = seed.dt;
    const steps = Math.round(dt / physicsPeriod);
    const targetZ = [ref, target[0], target[1], 0, 0, 0];
    let base = roll(start, seed.controls, targetZ, steps, dt);
    if (!Number.isFinite(base.cost)) return null;
    let regularization = 0.05;
    const margin = clearance(start);
    let derivatives;
    for (let iteration = 0; iteration <= budget; iteration++) {
      if (closeToTarget(base.states.at(-1), targetZ, 0.85) && base.peak < rail - margin) {
        const valid = verifyPlan(start, base.commands, dt, ref, checkCapture);
        if (valid) return valid;
      }
      if (iteration === budget) break;
      yield {label: iterationLabel, iteration: iteration + 1, budget};
      if (!derivatives) derivatives = base.commands.map((u, i) => derivative(base.states[i], u, steps));
      const policy = backward(base, targetZ, dt, derivatives, regularization);
      let best = null;
      if (policy) {
        for (const alpha of [1, 0.5, 0.25, 0.125, 0.0625, 0.025]) {
          const trial = roll(start, base.commands, targetZ, steps, dt, base, policy, alpha);
          if (trial.cost < base.cost - 1e-8 && (!best || trial.cost < best.cost)) best = trial;
          if (trial.cost < 0.72 * base.cost) break;
        }
      }
      if (best) {
        base = best;
        derivatives = null;
        regularization = Math.max(1e-7, regularization * 0.45);
      } else {
        regularization *= 6;
        if (regularization > 1e6) break;
      }
    }
    return null;
  }

  function resample(seed, dt = seed.dt) {
    const count = Math.round(seed.controls.length * seed.dt / dt);
    return Array.from({length: count}, (_, i) =>
      seed.controls[Math.min(seed.controls.length - 1, Math.floor((i * dt + 1e-8) / seed.dt))]);
  }

  function seedCandidates(start, seeds) {
    const list = [];
    for (const seed of seeds) {
      for (const mirror of [1, -1]) {
        const mapped = seed.z0.map(value => value * mirror);
        const startAngles = [1, 2].map(i => mapped[i] + Math.round((start[i] - mapped[i]) / (2 * Math.PI)) * 2 * Math.PI);
        const seedEnd = seed.target ?? [0, 0];
        const target = startAngles.map((value, i) => value + mirror * seedEnd[i] - mapped[i + 1]);
        const origin = [mapped[0], ...startAngles, mapped[3], mapped[4], mapped[5]];
        const delta = error(start, origin, false);
        const score = dot(delta, delta.map((value, i) => value * [0.2, 1, 1, 0.12, 0.06, 0.06][i]));
        const controls = resample(seed).map(value => value * mirror);
        list.push({target, origin, seed: {dt: seed.dt, controls}, score});
      }
    }
    return list.sort((a, b) => a.score - b.score);
  }

  function harmonicCandidates(start) {
    const dt = 0.04;
    const branches = [1, 2].map(i => [0, (start[i] > 0 ? 1 : -1) * 2 * Math.PI]);
    const targets = branches[0].flatMap(a => branches[1].map(b => [a, b]));
    const ordered = targets.sort((a, b) => Math.hypot(a[0] - start[1], a[1] - start[2])
      - Math.hypot(b[0] - start[1], b[1] - start[2]));
    const list = [];
    for (const [frequency, phase] of [[0.95, 0], [1.35, Math.PI / 2], [0.75, Math.PI]]) {
      for (const target of ordered.slice(0, 2)) {
        const controls = Array.from({length: 95}, (_, i) =>
          11 * Math.sin(2 * Math.PI * frequency * i * dt + phase) * Math.sin(Math.PI * i / 95));
        list.push({target, seed: {dt, controls}, score: Infinity});
      }
    }
    return list;
  }

  const checkLqrCapture = (z, ref, margin, elapsed, applied) =>
    captureCanSettle(z, ref, margin, makeLqr(), elapsed, applied);

  function* plan(state, ref, seeds, makeRegulator = makeLqr, startTime = 0) {
    const checkCapture = (z, target, margin, elapsed, applied) =>
      captureCanSettle(z, target, margin, makeRegulator(), startTime + elapsed, applied);
    const obstruction = viableObstruction(state);
    if (obstruction) return {obstruction};
    const local = localCandidate(state, ref, checkCapture);
    if (local) return local;
    const start = principalState(state);
    const nearest = seedCandidates(start, seeds).slice(0, 6);
    for (const {seed} of nearest) {
      const exact = verifyPlan(start, seed.controls, seed.dt, ref, checkCapture);
      if (exact) return exact;
    }
    for (let i = 0; i < Math.min(4, nearest.length); i++) {
      const {target, origin, seed} = nearest[i];
      const correction = SwingProjection.repair(start, [ref, ...target, 0, 0, 0], seed.dt, seed.controls, origin);
      let iteration = 0;
      let item = correction.next();
      while (!item.done) {
        yield {label: "校正备用轨迹 " + (i + 1) + " / " + Math.min(4, nearest.length), iteration: ++iteration};
        item = correction.next();
      }
      if (item.value) {
        const valid = verifyPlan(start, item.value, seed.dt, ref, checkCapture);
        if (valid) return valid;
      }
    }
    const candidates = nearest.concat(harmonicCandidates(start));
    for (let i = 0; i < candidates.length; i++) {
      const {target, seed, score} = candidates[i];
      const result = yield* improve(start, ref, target, seed, score < 0.05 ? 18 : 36,
        "候选 " + (i + 1) + " / " + candidates.length, checkCapture);
      if (result) return result;
    }
    return null;
  }

  function build(regulator = makeLqr()) {
    let trajectory = null;
    let index = 0;
    return {
      detail: regulator.detail,
      ready: () => trajectory !== null,
      phase: () => trajectory && index < trajectory.length ? "轨迹摆起" : "直立反馈",
      setPlan(solution) {
        trajectory = solution.trajectory;
        index = 0;
      },
      run({z, ref, dt, t, applied}) {
        if (!trajectory) throw new Error("请先计算摆起轨迹");
        const sample = trajectory[index];
        if (sample) {
          index += 1;
          return sample.u - dot(sample.K, error(z, sample.z, true));
        }
        return regulator.run({z: principalState(z), ref, dt, t, applied});
      },
    };
  }

  return {plan, build, principalState, viableObstruction, verifyPlan};
})();
