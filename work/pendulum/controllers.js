const Control = (() => {
  const period = 0.01;
  const defaultQ = "20 150 150 8 2 2";
  const defaultR = "0.8";
  const qField = { key: "q", label: "Q 对角线（6 项）", value: defaultQ, hint: "按 x, θ₁, θ₂, v, ω₁, ω₂ 排列" };
  const rField = { key: "r", label: "R（推力惩罚）", value: defaultR };
  const integralLimit = { key: "integralLimit", label: "积分限幅（m·s）", value: "2" };

  const definitions = [
    {
      id: "lqr",
      name: "LQR · 最优反馈",
      description: "使用全部 6 个状态。增大某项 Q 会加重对应偏差的代价，增大 R 会加重推力的代价。",
      fields: [qField, rField],
    },
    {
      id: "pole",
      name: "极点配置",
      description: "用 Ackermann 公式按 6 个指定的连续极点计算反馈增益。",
      fields: [
        { key: "poles", label: "闭环极点（6 个实数，s⁻¹）", value: "-1.8 -2.4 -3.4 -4.8 -6.5 -8", hint: "全部为负数，允许重复根" },
      ],
    },
    {
      id: "lqi",
      name: "LQI · 带积分的 LQR",
      description: "把小车位置误差的积分作为第七个状态，适合抑制恒定扰动造成的稳态位置偏差。",
      fields: [
        qField,
        { key: "qi", label: "积分权重 Qᵢ", value: "6" },
        rField,
        integralLimit,
      ],
    },
    {
      id: "pid",
      name: "PID + 双摆角 PD",
      description: "位置 PID 与两路摆角 PD 并联，三路反馈相加形成小车推力。",
      fields: [
        { key: "position", label: "位置 Kp、Ki、Kd（3 项）", value: "7.9794 2.3079 9.8673" },
        { key: "angles", label: "摆角 Kp₁、Kd₁、Kp₂、Kd₂（4 项）", value: "-113.9422 2.2118 164.5176 21.5020" },
        integralLimit,
      ],
    },
    {
      id: "mpc",
      name: "MPC · 约束预测控制",
      description: "用线性模型预测未来，在推力约束内优化整段控制量，每次只执行第一步。",
      fields: [
        qField,
        rField,
        { key: "horizon", label: "预测步数（每步 10 ms）", value: "28", hint: "5–60 的整数，末端代价取离散 Riccati 解" },
        { key: "bound", label: "MPC 稳摆推力上限（N）", value: "30", hint: "摆起阶段使用执行器限幅" },
      ],
    },
    {
      id: "observer",
      name: "观测器 + LQR",
      description: "只读取小车位置和两杆角度，用线性观测器估计速度，再计算状态反馈。",
      fields: [
        qField,
        rField,
        { key: "rate", label: "估计误差衰减速率（s⁻¹）", value: "55" },
      ],
    },
    {
      id: "sliding",
      name: "SMC · 滑模控制",
      description: "在直立线性模型上设计滑模面，用饱和函数平滑切换项，以减轻抖振。",
      fields: [
        { key: "poles", label: "滑模面极点（5 个实数，s⁻¹）", value: "-1.8 -2.4 -3.4 -4.8 -6.5" },
        { key: "reach", label: "线性趋近速率（s⁻¹）", value: "8" },
        { key: "switch", label: "切换项幅值（N）", value: "2" },
        { key: "width", label: "边界层宽度（N·s）", value: "0.35" },
      ],
    },
    {
      id: "gain",
      name: "手填状态反馈 K",
      description: "直接输入六个反馈增益。全部用同一负反馈符号，允许增益为负。",
      fields: [
        { key: "gain", label: "K（6 项）", value: "4.2234 -114.7620 155.3348 7.2042 0.6770 20.0823", hint: "按 x, θ₁, θ₂, v, ω₁, ω₂ 排列" },
      ],
    },
    {
      id: "open",
      name: "开环 · 信号发生器",
      description: "生成常量或正弦推力。开启自动摆起时，信号叠加在 LQR 稳摆推力上。关闭后可观察纯开环响应。",
      fields: [
        { key: "bias", label: "直流推力（N）", value: "0" },
        { key: "amplitude", label: "正弦幅值（N）", value: "0" },
        { key: "frequency", label: "频率（Hz）", value: "1" },
      ],
    },
  ];

  const zeros = (rows, columns) => Array.from({ length: rows }, () => Array(columns).fill(0));
  const identity = size => zeros(size, size).map((row, i) => row.map((_, j) => Number(i === j)));
  const dot = (left, right) => left.reduce((sum, value, i) => sum + value * right[i], 0);
  const transpose = matrix => matrix[0].map((_, j) => matrix.map(row => row[j]));
  const scale = (matrix, scalar) => matrix.map(row => row.map(value => value * scalar));
  const multiply = (left, right) => {
    const columns = transpose(right);
    return left.map(row => columns.map(column => dot(row, column)));
  };

  function vector(source, size, label) {
    const entries = String(source ?? "").trim().split(/[\s,，;；]+/);
    const numbers = entries.map(value => value === "" ? NaN : Number(value));
    if (numbers.length !== size || !numbers.every(Number.isFinite)) {
      throw new Error(label + "需要 " + size + " 个有限数值");
    }
    return numbers;
  }

  function scalar(source, label, min, max) {
    const [number] = vector(source, 1, label);
    if (number < min || number > max) {
      throw new Error(label + "的范围是 " + min + " 至 " + max);
    }
    return number;
  }

  const errorState = (z, ref) => [z[0] - ref, ...z.slice(1)];
  const format = number => Math.abs(number) < 5e-7 ? "0" : Number(number.toPrecision(6)).toString();
  const formatVector = values => "[" + values.map(format).join(", ") + "]";
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
  const diagonal = weights => weights.map((weight, i) => weights.map((_, j) => i === j ? weight : 0));

  // Zero-order hold via the convergent exponential series at a 10 ms sample period.
  function discretize(A, B, dt = period) {
    let termA = identity(A.length);
    let termB = scale(B, dt);
    const Ad = identity(A.length);
    const Bd = termB.map(row => row.slice());
    for (let order = 1; order <= 24; order += 1) {
      termA = scale(multiply(termA, A), dt / order);
      termB = scale(multiply(A, termB), dt / (order + 1));
      for (let i = 0; i < A.length; i += 1) {
        for (let j = 0; j < A.length; j += 1) Ad[i][j] += termA[i][j];
        for (let j = 0; j < B[0].length; j += 1) Bd[i][j] += termB[i][j];
      }
    }
    return { A: Ad, B: Bd };
  }

  function plantDiscrete(integral = false) {
    const A = Plant.A.map(row => row.slice());
    const B = Plant.B.map(value => [value]);
    if (integral) {
      A.forEach(row => row.push(0));
      A.push([1, 0, 0, 0, 0, 0, 0]);
      B.push([0]);
    }
    const plant = discretize(A, B);
    return { A: plant.A, B: plant.B.map(row => row[0]) };
  }

  function weights(values) {
    const Q = vector(values.q, 6, "Q 对角线");
    if (Q.some(value => value < 0 || value > 1e7) || Q.every(value => value === 0)) {
      throw new Error("Q 对角线各项须在 0 至 10⁷ 范围内，至少一项大于 0");
    }
    return { Q, R: scalar(values.r, "R", 0.0001, 1e7) };
  }

  function solveLqr({ A, B }, Q, R) {
    const AT = transpose(A);
    let P = diagonal(Q);
    for (let iteration = 0; iteration < 12000; iteration += 1) {
      const PB = P.map(row => dot(row, B));
      const AT_PB = AT.map(row => dot(row, PB));
      const divisor = R + dot(B, PB);
      const AT_PA = multiply(multiply(AT, P), A);
      let delta = 0;
      let magnitude = 1;
      const next = AT_PA.map((row, i) => row.map((value, j) => {
        const updated = (value + AT_PA[j][i]) / 2 - AT_PB[i] * AT_PB[j] / divisor + (i === j ? Q[i] : 0);
        delta = Math.max(delta, Math.abs(updated - P[i][j]));
        magnitude = Math.max(magnitude, Math.abs(updated));
        return updated;
      }));
      if (!Number.isFinite(magnitude)) break;
      P = next;
      if (delta <= 1e-10 * magnitude) {
        const finalPB = P.map(row => dot(row, B));
        const denominator = R + dot(B, finalPB);
        return { P, K: AT.map(row => dot(row, finalPB) / denominator) };
      }
    }
    throw new Error("Riccati 方程未收敛，请把 Q 或 R 调回更温和的范围");
  }

  function linearFeedback(K, detail = "") {
    return {
      run: ({ z, ref }) => -dot(K, errorState(z, ref)),
      detail: "u = −K·e，K = " + formatVector(K) + (detail ? "。 " + detail : ""),
    };
  }

  function solveLinear(matrix, right) {
    const n = matrix.length;
    const augmented = matrix.map((row, i) => [...row, right[i]]);
    for (let column = 0; column < n; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < n; row += 1) {
        if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("可控矩阵奇异，无法配置极点");
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      for (let row = column + 1; row < n; row += 1) {
        const factor = augmented[row][column] / augmented[column][column];
        for (let j = column; j <= n; j += 1) augmented[row][j] -= factor * augmented[column][j];
      }
    }
    const solution = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let residual = augmented[i][n];
      for (let j = i + 1; j < n; j += 1) residual -= augmented[i][j] * solution[j];
      solution[i] = residual / augmented[i][i];
    }
    return solution;
  }

  function controlledPolynomialRow(poles) {
    const { A, B } = Plant;
    const n = A.length;
    const controlColumns = [B];
    let nextColumn = B;
    for (let i = 1; i < n; i += 1) {
      nextColumn = A.map(row => dot(row, nextColumn));
      controlColumns.push(nextColumn);
    }
    const selector = Array(n).fill(0);
    selector[n - 1] = 1;
    let row = solveLinear(controlColumns, selector);
    const AT = transpose(A);
    // eₙᵀ Wc⁻¹ ∏(A − λᵢI).
    for (const pole of poles) row = AT.map((column, i) => dot(row, column) - pole * row[i]);
    return row;
  }

  function stablePoles(source, count) {
    const poles = vector(source, count, "极点");
    if (poles.some(value => value > -0.05 || value < -30)) {
      throw new Error("每个极点须在 −30 至 −0.05 s⁻¹ 范围内");
    }
    return poles;
  }

  function integralFeedback(K, Ki, maxIntegral, detail) {
    let integral = 0;
    return {
      run: ({ z, ref, dt }) => {
        const e = errorState(z, ref);
        const baseline = -dot(K, e);
        const before = baseline - Ki * integral;
        const candidateIntegral = clamp(integral + dt * e[0], maxIntegral);
        const candidate = baseline - Ki * candidateIntegral;
        const limit = Plant.params.forceLimit;
        // If saturated, permit integration only when it unwinds the saturation.
        if (Math.abs(candidate) <= limit || Math.abs(candidate) < Math.abs(before)) integral = candidateIntegral;
        return baseline - Ki * integral;
      },
      reset: () => { integral = 0; },
      detail: detail + " K = " + formatVector(K) + "，Kᵢ = " + format(Ki) + "。推力饱和时抑制积分累积。",
    };
  }

  function cholesky(matrix) {
    const n = matrix.length;
    const lower = zeros(n, n);
    for (let row = 0; row < n; row += 1) {
      for (let column = 0; column <= row; column += 1) {
        let residual = matrix[row][column];
        for (let j = 0; j < column; j += 1) residual -= lower[row][j] * lower[column][j];
        if (row === column && !(residual > 0)) throw new Error("MPC 的代价矩阵不再正定");
        lower[row][column] = row === column ? Math.sqrt(residual) : residual / lower[column][column];
      }
    }
    return lower;
  }

  function solveCholesky(lower, right) {
    const result = right.slice();
    for (let row = 0; row < result.length; row += 1) {
      for (let j = 0; j < row; j += 1) result[row] -= lower[row][j] * result[j];
      result[row] /= lower[row][row];
    }
    for (let row = result.length - 1; row >= 0; row -= 1) {
      for (let j = row + 1; j < result.length; j += 1) result[row] -= lower[j][row] * result[j];
      result[row] /= lower[row][row];
    }
    return result;
  }

  function predictController(horizon, bound, Q, R) {
    const { A, B } = plantDiscrete();
    const { P } = solveLqr({ A, B }, Q, R);
    const n = A.length;
    const H = diagonal(Array(horizon).fill(R));
    const C = zeros(horizon, n);
    const stageQ = diagonal(Q);
    let stateMap = identity(n);
    let inputMap = zeros(n, horizon);

    // Condense the predicted states into e[k] = stateMap * e[0] + inputMap * U.
    for (let k = 1; k <= horizon; k += 1) {
      stateMap = multiply(A, stateMap);
      inputMap = multiply(A, inputMap);
      for (let i = 0; i < n; i += 1) inputMap[i][k - 1] = B[i];
      const weightedInputs = multiply(transpose(inputMap), k === horizon ? P : stageQ);
      const inputCost = multiply(weightedInputs, inputMap);
      const crossCost = multiply(weightedInputs, stateMap);
      for (let i = 0; i < k; i += 1) {
        for (let j = 0; j < k; j += 1) H[i][j] += inputCost[i][j];
        for (let j = 0; j < n; j += 1) C[i][j] += crossCost[i][j];
      }
    }

    const lower = cholesky(H);
    let lastSequence;
    return {
      run: ({ z, ref }) => {
        const e = errorState(z, ref);
        const gradientOffset = C.map(row => dot(row, e));
        const free = solveCholesky(lower, gradientOffset.map(value => -value));
        if (free.every(value => Math.abs(value) <= bound)) {
          lastSequence = free;
          return free[0];
        }
        const U = lastSequence
          ? [...lastSequence.slice(1), lastSequence[horizon - 1]]
          : free.map(value => clamp(value, bound));
        const gradient = H.map((row, i) => dot(row, U) + gradientOffset[i]);
        for (let sweep = 0; sweep < 30; sweep += 1) {
          let largestUpdate = 0;
          for (let i = 0; i < horizon; i += 1) {
            const change = clamp(U[i] - gradient[i] / H[i][i], bound) - U[i];
            U[i] += change;
            largestUpdate = Math.max(largestUpdate, Math.abs(change));
            for (let j = 0; j < horizon; j += 1) gradient[j] += H[j][i] * change;
          }
          if (largestUpdate < 1e-5) break;
        }
        lastSequence = U;
        return U[0];
      },
      reset: () => { lastSequence = undefined; },
      detail: "预测窗 " + format(horizon * period) + " s，约束 |u| ≤ " + format(bound)
        + " N。使用离散 LQR 的末端代价，带约束时迭代求解。",
    };
  }

  function observerFeedback(K, rate) {
    const { A, B } = plantDiscrete();
    const positionFromVelocity = A.slice(0, 3).map(row => row.slice(3));
    const velocityFromVelocity = A.slice(3).map(row => row.slice(3));
    const pole = Math.exp(-rate * period);
    const target = velocityFromVelocity.map((row, i) => row.map((value, j) => value - (i === j ? pole : 0)));
    // Reduced-order observer error advances by Ad_vv − L Ad_qv. Select this as pole*I.
    const measurementMap = transpose(positionFromVelocity);
    const L = target.map(row => solveLinear(measurementMap, row));
    let prediction;
    return {
      run: ({ z, ref, applied }) => {
        const measured = z.slice(0, 3);
        let velocity = [0, 0, 0];
        if (prediction) {
          const correction = Number.isFinite(applied) ? applied - prediction.input : 0;
          const residual = measured.map((value, i) => value - prediction.state[i] - B[i] * correction);
          velocity = L.map((row, i) => prediction.state[i + 3] + B[i + 3] * correction + dot(row, residual));
        }
        const estimate = [...measured, ...velocity];
        const u = -dot(K, errorState(estimate, ref));
        const input = clamp(u, Plant.params.forceLimit);
        prediction = { input, state: A.map((row, i) => dot(row, estimate) + B[i] * input) };
        return u;
      },
      reset: () => { prediction = undefined; },
      detail: "测量 y = [x, θ₁, θ₂]ᵀ，降阶观测器的离散极点均为 " + format(pole)
        + "。使用 u = −K·ê，K = " + formatVector(K) + "。",
    };
  }

  function build(id, input = {}) {
    const definition = definitions.find(candidate => candidate.id === id);
    if (!definition) throw new Error("未知控制器");
    const values = { ...Object.fromEntries(definition.fields.map(field => [field.key, field.value])), ...input };

    switch (id) {
      case "lqr": {
        const { Q, R } = weights(values);
        return linearFeedback(solveLqr(plantDiscrete(), Q, R).K, "以 10 ms 零阶保持模型设计。");
      }
      case "pole": {
        const poles = stablePoles(values.poles, 6);
        return linearFeedback(controlledPolynomialRow(poles), "连续闭环极点 λ = " + formatVector(poles) + " s⁻¹。");
      }
      case "lqi": {
        const { Q, R } = weights(values);
        const integralWeight = scalar(values.qi, "积分权重", 0.0001, 1e7);
        const limit = scalar(values.integralLimit, "积分限幅", 0.001, 100);
        const { K } = solveLqr(plantDiscrete(true), [...Q, integralWeight], R);
        return integralFeedback(K.slice(0, 6), K[6], limit, "u = −K·e − Kᵢ∫(x−xᵣ)dt。");
      }
      case "pid": {
        const [positionP, positionI, positionD] = vector(values.position, 3, "位置 PID");
        const [angle1P, angle1D, angle2P, angle2D] = vector(values.angles, 4, "摆角 PD");
        const limit = scalar(values.integralLimit, "积分限幅", 0.001, 100);
        const K = [positionP, angle1P, angle2P, positionD, angle1D, angle2D];
        return integralFeedback(K, positionI, limit, "位置 PID 与两杆 PD 的总和，u = −K·e − Kᵢ∫(x−xᵣ)dt。");
      }
      case "mpc": {
        const { Q, R } = weights(values);
        const horizon = scalar(values.horizon, "预测步数", 5, 60);
        if (!Number.isInteger(horizon)) throw new Error("预测步数必须为整数");
        const bound = scalar(values.bound, "推力上限", 0.1, Plant.params.forceLimit);
        return predictController(horizon, bound, Q, R);
      }
      case "observer": {
        const { Q, R } = weights(values);
        const rate = scalar(values.rate, "观测器衰减速率", 1, 100);
        return observerFeedback(solveLqr(plantDiscrete(), Q, R).K, rate);
      }
      case "sliding": {
        const surface = controlledPolynomialRow(stablePoles(values.poles, 5));
        const reach = scalar(values.reach, "趋近速率", 0.01, 30);
        const switching = scalar(values.switch, "切换项幅值", 0, Plant.params.forceLimit);
        const width = scalar(values.width, "边界层宽度", 0.001, 30);
        const SA = transpose(Plant.A).map(column => dot(surface, column));
        const SB = dot(surface, Plant.B);
        return {
          run: ({ z, ref }) => {
            const e = errorState(z, ref);
            const s = dot(surface, e);
            return -(dot(SA, e) + reach * s + switching * clamp(s / width, 1)) / SB;
          },
          detail: "s = S·e，S = " + formatVector(surface) + "。"
            + "u = −(S·A·e + k·s + η·sat(s/φ)) / (S·B)。",
        };
      }
      case "gain":
        return linearFeedback(vector(values.gain, 6, "反馈增益"));
      case "open": {
        const bias = scalar(values.bias, "直流推力", -Plant.params.forceLimit, Plant.params.forceLimit);
        const amplitude = scalar(values.amplitude, "正弦幅值", 0, Plant.params.forceLimit);
        const frequency = scalar(values.frequency, "频率", 0, 30);
        return {
          run: ({ t }) => bias + amplitude * Math.sin(2 * Math.PI * frequency * t),
          detail: "u(t) = " + format(bias) + " + " + format(amplitude) + "·sin(2π·" + format(frequency) + "·t) N。",
        };
      }
    }
  }

  return { definitions, build };
})();
