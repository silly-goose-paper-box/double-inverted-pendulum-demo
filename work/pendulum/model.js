const Plant = (() => {
  const params = Object.freeze({
    M: 1.0,
    m1: 0.20,
    m2: 0.10,
    L1: 0.50,
    L2: 0.40,
    g: 9.81,
    b: 0.08,
    forceLimit: 36,
    railLimit: 2.8,
  });

  const { M, m1, m2, L1, L2, g, b } = params;
  const totalMass = M + m1 + m2;
  const p1 = m1 * L1 / 2 + m2 * L1;
  const p2 = m2 * L2 / 2;
  const j1 = m1 * L1 ** 2 / 3 + m2 * L1 ** 2;
  const j2 = m2 * L2 ** 2 / 3;
  const coupling = m2 * L1 * L2 / 2;
  const constants = Object.freeze({ totalMass, p1, p2, j1, j2, coupling });
  const initialState = Object.freeze([0, 0.05, -0.035, 0, 0, 0]);

  function mass(q) {
    const [, theta1, theta2] = q;
    const cross1 = p1 * Math.cos(theta1);
    const cross2 = p2 * Math.cos(theta2);
    const crossLinks = coupling * Math.cos(theta1 - theta2);
    return [
      [totalMass, cross1, cross2],
      [cross1, j1, crossLinks],
      [cross2, crossLinks, j2],
    ];
  }

  function solveMass(matrix, right) {
    // The inertia matrix is symmetric positive definite at every configuration.
    const [[h00, h01, h02], [, h11, h12], [, , h22]] = matrix;
    const factor1 = h01 / h00;
    const factor2 = h02 / h00;
    const pivot1 = h11 - factor1 * h01;
    const cross = h12 - factor1 * h02;
    const factor21 = cross / pivot1;
    const pivot2 = h22 - factor2 * h02 - factor21 * cross;
    const right1 = right[1] - factor1 * right[0];
    const right2 = right[2] - factor2 * right[0] - factor21 * right1;
    const acceleration2 = right2 / pivot2;
    const acceleration1 = (right1 - cross * acceleration2) / pivot1;
    const acceleration0 = (right[0] - h01 * acceleration1 - h02 * acceleration2) / h00;
    return [acceleration0, acceleration1, acceleration2];
  }

  function dynamics(state, force) {
    const [, theta1, theta2, v, omega1, omega2] = state;
    const moment1 = p1 * Math.sin(theta1);
    const moment2 = p2 * Math.sin(theta2);
    const cross = coupling * Math.sin(theta1 - theta2);
    const acceleration = solveMass(mass(state), [
      force - b * v + moment1 * omega1 ** 2 + moment2 * omega2 ** 2,
      g * moment1 - cross * omega2 ** 2,
      g * moment2 + cross * omega1 ** 2,
    ]);
    return [v, omega1, omega2, ...acceleration];
  }

  function step(state, force, dt) {
    const k1 = dynamics(state, force);
    const k2 = dynamics(state.map((value, i) => value + dt * k1[i] / 2), force);
    const k3 = dynamics(state.map((value, i) => value + dt * k2[i] / 2), force);
    const k4 = dynamics(state.map((value, i) => value + dt * k3[i]), force);
    return state.map((value, i) => value + dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
  }

  const uprightMass = mass([0, 0, 0]);
  const forceColumn = solveMass(uprightMass, [1, 0, 0]);
  const gravityColumn1 = solveMass(uprightMass, [0, g * p1, 0]);
  const gravityColumn2 = solveMass(uprightMass, [0, 0, g * p2]);
  const A = Object.freeze([
    [0, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 1],
    ...forceColumn.map((entry, i) => [0, gravityColumn1[i], gravityColumn2[i], -b * entry, 0, 0]),
  ].map(row => Object.freeze(row)));
  const B = Object.freeze([0, 0, 0, ...forceColumn]);

  return Object.freeze({ params, constants, initialState, mass, dynamics, step, A, B });
})();
