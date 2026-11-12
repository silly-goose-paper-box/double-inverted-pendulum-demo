(() => {
  const byId = id => document.getElementById(id);
  const DEG = 180 / Math.PI;
  const PERIOD = 0.01;
  const DEFAULT_INITIAL = [0, -Math.PI, -Math.PI, 0, 0, 0];
  const UPRIGHT_INITIAL = [0, 0.08, -0.06, 0, 0, 0];
  const CUSTOM_DEFAULT = "119.3952*th1 - 152.9691*th2 - 3.1623*ex - 5.8254*v + 0.4434*w1 - 19.6260*w2";
  const swingDefinition = {
    id: "swing",
    name: "非线性摆起 → LQR 稳定",
    description: "先根据当前状态计算有限推力、有限轨道内的轨迹。两杆摆到直立附近后，由 LQR 接管。",
    fields: [],
  };
  const definitions = new Map([swingDefinition, ...Control.definitions].map(definition => [definition.id, definition]));
  definitions.set("custom", {
    id: "custom",
    name: "自定义公式",
    description: "输入静态或动态控制律。默认示例是稳定直立点的全状态反馈，可直接修改。",
    fields: [],
  });

  const scene = byId("scene");
  const chartNames = ["position", "angles", "velocity", "angularVelocity", "force"];
  const plots = Object.fromEntries(chartNames.map(name => [name, byId("chart-" + name)]));
  const graphics = Visuals.create({scene, plots, params: Plant.params});
  const picker = byId("controller");
  const fields = byId("controller-fields");
  const result = byId("controller-result");
  const refs = byId("reference");
  const dynamics = byId("dynamics-type");
  const autoSwing = byId("auto-swing");
  const status = byId("status");
  const stepButton = byId("single-step");
  const initialInputs = [...document.querySelectorAll("[data-initial]")];
  const configuration = new Map();
  const customInputs = ["custom-u", "custom-ds1", "custom-ds2", "custom-ds3"].map(byId);

  for (const definition of definitions.values()) {
    const option = document.createElement("option");
    option.value = definition.id;
    option.textContent = definition.name;
    picker.append(option);
    configuration.set(definition.id, Object.fromEntries(definition.fields.map(field => [field.key, field.value])));
  }
  picker.value = "swing";

  let activeId = "swing";
  let makeRegulator = () => Control.build("lqr");
  let controller = SwingPlanner.build(makeRegulator());
  let initial = DEFAULT_INITIAL.slice();
  let z = initial.slice();
  let ref = 0;
  let force = 0;
  let disturbance = 0;
  let disturbanceTicks = 0;
  let ticks = 0;
  let history = [];
  let playing = false;
  let fault = "";
  let lastTime = 0;
  let lastPaint = 0;
  let accumulator = 0;
  let frameId = null;
  let planning = null;

  function displayController(text, tone = "ok") {
    result.textContent = text;
    result.dataset.tone = tone;
  }

  function setDirty() {
    displayController("待应用 · 当前运行：" + definitions.get(activeId).name, "pending");
  }

  function setDefaultCustom() {
    customInputs.forEach((input, index) => { input.value = index === 0 ? CUSTOM_DEFAULT : "0"; });
  }

  function renderFields() {
    const definition = definitions.get(picker.value);
    const values = configuration.get(picker.value);
    byId("controller-description").textContent = definition.description;
    byId("custom-fields").hidden = definition.id !== "custom";
    fields.replaceChildren();
    for (const field of definition.fields) {
      const label = document.createElement("label");
      label.className = "field";
      const title = document.createElement("span");
      title.textContent = field.label;
      const input = document.createElement("input");
      input.type = "text";
      input.value = values[field.key];
      input.spellcheck = false;
      input.autocomplete = "off";
      input.maxLength = 240;
      input.addEventListener("input", () => {
        values[field.key] = input.value;
        setDirty();
      });
      label.append(title, input);
      if (field.hint) {
        const hint = document.createElement("small");
        hint.className = "helper";
        hint.textContent = field.hint;
        label.append(hint);
      }
      fields.append(label);
    }
  }

  function usesSwing(id = activeId) {
    return id === "swing" || (autoSwing.checked && dynamics.value === "nonlinear");
  }

  function makeCaptureRegulator(id, factory) {
    if (id !== "open" || !usesSwing(id)) return factory;
    return () => {
      const signal = factory();
      const lqr = Control.build("lqr");
      return {
        detail: "LQR 稳摆 + 开环信号。" + signal.detail,
        run: input => lqr.run(input) + signal.run(input),
      };
    };
  }

  function showAppliedController() {
    const startup = controller.ready ? "自动摆起 · 直立后接管\n" : "";
    displayController("已应用 · " + definitions.get(activeId).name + "\n" + startup + controller.detail);
  }

  function applyController() {
    const id = picker.value;
    try {
      let factory;
      if (id === "swing") {
        factory = () => Control.build("lqr");
      } else if (id === "custom") {
        const [u, ...rates] = customInputs.map(input => input.value);
        factory = () => Expression.controller(u, rates);
      } else {
        const values = {...configuration.get(id)};
        factory = () => Control.build(id, values);
      }
      const capture = makeCaptureRegulator(id, factory);
      const next = capture();
      if (id === "custom") {
        next.run({z: SwingPlanner.principalState(z), ref, t: ticks * PERIOD, dt: 0});
      }
      if (planning || (playing && usesSwing(id))) pause();
      activeId = id;
      makeRegulator = factory;
      controller = usesSwing() ? SwingPlanner.build(next) : next;
      dynamics.disabled = id === "swing";
      if (id === "swing") dynamics.value = "nonlinear";
      autoSwing.disabled = id === "swing" || dynamics.value === "linear";
      showAppliedController();
      if (fault.startsWith("控制器") || fault === "未找到可行轨迹" || fault === "轨道约束不可满足") fault = "";
      updateTransport();
    } catch (error) {
      displayController(error.message + "\n当前运行：" + definitions.get(activeId).name, "error");
    }
  }

  function setStatus(message, mode) {
    if (status.textContent !== message) status.textContent = message;
    status.dataset.mode = mode;
  }

  function updateTransport() {
    byId("play-label").textContent = planning ? "取消规划" : playing ? "暂停仿真" : ticks ? "继续仿真" : "运行仿真";
    byId("play-icon").textContent = planning ? "■" : playing ? "Ⅱ" : "▶";
    byId("play").disabled = Boolean(fault);
    stepButton.disabled = playing || Boolean(planning) || Boolean(fault);
    if (fault) setStatus(fault, "error");
    else if (planning) setStatus("计算摆起轨迹", "running");
    else if (playing) setStatus(disturbanceTicks ? "扰动中" : controller.phase?.() ?? "运行中", "running");
    else setStatus(disturbanceTicks ? "扰动已就绪" : ticks ? "已暂停" : "待运行", "paused");
  }

  function record() {
    history.push({t: ticks * PERIOD, z, u: force, ref, disturbance});
  }

  function fixed(value, digits) {
    return (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
  }

  function draw() {
    const windowSeconds = Number(byId("chart-window").value);
    const visibleSamples = Math.ceil(windowSeconds / PERIOD) + 2;
    graphics.drawScene(z, ref, force);
    graphics.drawPlots(history.slice(-visibleSamples), {windowSeconds});
    byId("time-value").textContent = fixed(ticks * PERIOD, 2);
    byId("x-value").textContent = fixed(z[0], 3);
    const principal = SwingPlanner.principalState(z);
    byId("t1-value").textContent = fixed(principal[1] * DEG, 2);
    byId("t2-value").textContent = fixed(principal[2] * DEG, 2);
    byId("u-value").textContent = fixed(force, 2);
  }

  function pause() {
    const wasPlanning = Boolean(planning);
    planning = null;
    playing = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    if (wasPlanning) displayController("规划已取消。再次点击运行即可重新计算。");
    updateTransport();
    draw();
  }

  function reset() {
    planning = null;
    playing = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    fault = "";
    ticks = 0;
    force = 0;
    disturbance = 0;
    disturbanceTicks = 0;
    z = dynamics.value === "linear" ? SwingPlanner.principalState(initial) : initial.slice();
    history = [];
    const next = makeCaptureRegulator(activeId, makeRegulator)();
    controller = usesSwing() ? SwingPlanner.build(next) : next;
    autoSwing.disabled = activeId === "swing" || dynamics.value === "linear";
    if (picker.value === activeId) {
      showAppliedController();
    }
    record();
    updateTransport();
    draw();
  }

  function linearStep(state, input, dt) {
    const rate = values => Plant.A.map((row, i) =>
      row.reduce((sum, coefficient, j) => sum + coefficient * values[j], Plant.B[i] * input));
    const k1 = rate(state);
    const k2 = rate(state.map((value, i) => value + dt * k1[i] / 2));
    const k3 = rate(state.map((value, i) => value + dt * k2[i] / 2));
    const k4 = rate(state.map((value, i) => value + dt * k3[i]));
    return state.map((value, i) => value + dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
  }

  function advance() {
    if (fault) return;
    const t = ticks * PERIOD;
    let desired;
    try {
      desired = controller.run({z: SwingPlanner.principalState(z), ref, dt: PERIOD, t, applied: force});
      if (!Number.isFinite(desired)) throw new Error("输出不是有限数值");
    } catch (error) {
      fault = "控制器输出异常";
      displayController("控制器停止 · " + error.message, "error");
      pause();
      return;
    }
    const limit = Plant.params.forceLimit;
    force = Math.max(-limit, Math.min(limit, desired));
    const usedDisturbance = disturbanceTicks > 0 ? disturbance : 0;
    const stepPlant = dynamics.value === "linear" ? linearStep : Plant.step;
    const half = stepPlant(z, force + usedDisturbance, PERIOD / 2);
    const next = stepPlant(half, force + usedDisturbance, PERIOD / 2);
    if (next.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7)) {
      fault = "状态数值发散";
      pause();
      return;
    }
    z = next;
    ticks += 1;
    if (!disturbanceTicks) disturbance = 0;
    record();
    if (disturbanceTicks) disturbanceTicks -= 1;
    if (Math.max(Math.abs(half[0]), Math.abs(z[0])) >= Plant.params.railLimit) {
      fault = "到达轨道边界";
      pause();
    }
  }

  function animate(now) {
    frameId = null;
    if (!playing) return;
    if (!lastTime) lastTime = now;
    const speed = Number(byId("speed").value);
    accumulator += Math.min((now - lastTime) / 1000, 0.1) * speed;
    lastTime = now;
    while (accumulator + 1e-10 >= PERIOD && playing) {
      advance();
      accumulator -= PERIOD;
    }
    if (now - lastPaint >= 1000 / 30) {
      lastPaint = now;
      updateTransport();
      draw();
    }
    if (playing) frameId = requestAnimationFrame(animate);
  }

  function startPlayback() {
    if (fault || playing) return;
    playing = true;
    lastTime = 0;
    lastPaint = 0;
    accumulator = 0;
    updateTransport();
    frameId = requestAnimationFrame(animate);
  }

  function describeObstruction(obstruction) {
    const direction = obstruction.direction > 0 ? "右侧" : "左侧";
    return direction + "质心位移下界 " + obstruction.bound.toFixed(3) + " kg·m，超过轨道内最多 "
      + obstruction.room.toFixed(3) + " kg·m。无外加扰动时，任何限幅控制律都无法阻止在 "
      + obstruction.time.toFixed(4) + " s 内越轨。";
  }

  function preparePlayback(callback) {
    if (fault || playing || planning) return;
    if (!controller.ready || controller.ready()) {
      callback();
      return;
    }
    const capture = makeCaptureRegulator(activeId, makeRegulator);
    const plan = SwingPlanner.plan(z, ref, SwingSeeds, capture, ticks * PERIOD);
    planning = plan;
    displayController("正在计算摆起轨迹。通过轨道和终端捕获检查后开始仿真。", "pending");
    updateTransport();
    const chunk = () => {
      if (planning !== plan) return;
      try {
        const frame = plan.next();
        if (!frame.done) {
          const item = frame.value;
          const limit = item.budget ? " / " + item.budget : "";
          displayController("正在计算摆起轨迹 · " + item.label + " · 迭代 " + item.iteration + limit, "pending");
          setTimeout(chunk, 0);
          return;
        }
        planning = null;
        const solution = frame.value;
        if (solution?.obstruction) {
          fault = "轨道约束不可满足";
          displayController(describeObstruction(solution.obstruction), "error");
        } else if (!solution) {
          fault = "未找到可行轨迹";
          displayController("在本次搜索预算内没有找到满足约束的摆起轨迹。可调整初始状态或目标位置后重试。", "error");
        } else {
          controller.setPlan(solution);
          const report = " · 校验最大 |x| = " + solution.travel.toFixed(3) + " m";
          const captureDetail = "\n直立接管 · " + definitions.get(activeId).name + "\n" + controller.detail;
          displayController(solution.seconds > 0
            ? "轨迹已通过名义仿真校验 · 摆起 " + solution.seconds.toFixed(2) + " s" + report
              + " · 摆起峰值推力 " + solution.peakForce.toFixed(1) + " N"
            + captureDetail
            : "当前初态已通过所选控制器的接管检查" + report + captureDetail);
          updateTransport();
          callback();
          return;
        }
      } catch (error) {
        planning = null;
        fault = "控制器规划异常";
        displayController("轨迹规划中止 · " + error.message, "error");
      }
      updateTransport();
      draw();
    };
    setTimeout(chunk, 0);
  }

  function changeReference(value) {
    if (planning) pause();
    ref = Number(value);
    refs.value = String(ref);
    byId("reference-value").textContent = fixed(ref, 2) + " m";
    if (!playing) {
      history[history.length - 1] = {...history.at(-1), ref};
      draw();
    }
    if (fault === "未找到可行轨迹") {
      fault = "";
      displayController("目标位置已修改。点击运行重新计算。", "pending");
      updateTransport();
    }
  }

  function push(sign) {
    disturbance = 8 * sign;
    disturbanceTicks = 12;
    updateTransport();
  }

  function applyInitial() {
    const values = initialInputs.map(input => input.value.trim() ? Number(input.value) : NaN);
    const error = byId("initial-error");
    if (values.some(value => !Number.isFinite(value))) {
      error.textContent = "请填写六个有限数值。";
      return;
    }
    if (Math.abs(values[0]) >= Plant.params.railLimit) {
      const limit = Plant.params.railLimit;
      error.textContent = "初始小车位置须在 −" + limit + " m 和 +" + limit + " m 之间。";
      return;
    }
    if (values.slice(1).some(value => Math.abs(value) > 1e4)) {
      error.textContent = "初始角度或速度的数值过大。";
      return;
    }
    initial = values.map((value, i) => [1, 2, 4, 5].includes(i) ? value / DEG : value);
    error.textContent = "";
    reset();
  }

  function setInitialFields(values) {
    initialInputs.forEach((input, i) => {
      input.value = [1, 2, 4, 5].includes(i) ? (values[i] * DEG).toFixed(2) : values[i].toString();
    });
  }

  function exportCsv() {
    const lines = ["t_s,x_m,theta1_rad,theta2_rad,v_m_per_s,omega1_rad_per_s,omega2_rad_per_s,control_N,reference_m,disturbance_N"];
    for (const point of history) {
      lines.push([point.t, ...point.z, point.u, point.ref, point.disturbance].map(value => value.toFixed(9)).join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], {type: "text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "double-inverted-pendulum.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function writeMatrix(root, values, label) {
    const table = document.createElement("table");
    table.setAttribute("aria-label", label);
    const body = document.createElement("tbody");
    for (const row of values) {
      const tr = document.createElement("tr");
      for (const value of row) {
        const td = document.createElement("td");
        td.textContent = value === 0 ? "0" : value.toFixed(6);
        if (value === 0) td.className = "zero";
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    root.append(table);
  }

  function writePlantParams() {
    const p = Plant.params;
    const list = [
      ["小车质量 M", p.M.toFixed(2) + " kg"],
      ["下杆质量 m₁", p.m1.toFixed(2) + " kg"],
      ["上杆质量 m₂", p.m2.toFixed(2) + " kg"],
      ["下杆长度 L₁", p.L1.toFixed(2) + " m"],
      ["上杆长度 L₂", p.L2.toFixed(2) + " m"],
      ["重力加速度 g", p.g.toFixed(2) + " m/s²"],
      ["小车黏性阻尼 b", p.b.toFixed(2) + " N·s/m"],
      ["两转轴阻尼", "0 N·m·s/rad"],
      ["执行器限幅", "±" + p.forceLimit + " N"],
      ["轨道位置范围", "±" + p.railLimit + " m"],
    ];
    for (const [label, value] of list) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      byId("plant-params").append(term, description);
    }
  }

  async function copyMatrices() {
    const matlab = values => values.map(row => row.map(value => Number(value.toPrecision(13))).join(", ")).join(";\n     ");
    const content = "A = [" + matlab(Plant.A) + "];\nB = [" + matlab(Plant.B.map(value => [value])) + "];\nC = eye(6);\nD = zeros(6,1);";
    try {
      await navigator.clipboard.writeText(content);
      byId("copy-status").textContent = "已复制 A、B、C、D。";
    } catch {
      const box = document.createElement("textarea");
      box.value = content;
      box.rows = 9;
      box.readOnly = true;
      box.setAttribute("aria-label", "MATLAB 矩阵文本");
      byId("copy-status").replaceChildren(box);
      box.focus();
      box.select();
      if (document.execCommand("copy")) byId("copy-status").textContent = "已复制 A、B、C、D。";
    }
  }

  picker.addEventListener("change", () => { renderFields(); setDirty(); });
  customInputs.forEach(input => input.addEventListener("input", setDirty));
  byId("apply-controller").addEventListener("click", applyController);
  byId("controller-defaults").addEventListener("click", () => {
    const definition = definitions.get(picker.value);
    configuration.set(definition.id, Object.fromEntries(definition.fields.map(field => [field.key, field.value])));
    if (definition.id === "custom") setDefaultCustom();
    renderFields();
    setDirty();
  });
  byId("play").addEventListener("click", () => playing || planning ? pause() : preparePlayback(startPlayback));
  byId("reset").addEventListener("click", reset);
  stepButton.addEventListener("click", () => {
    preparePlayback(() => { advance(); updateTransport(); draw(); });
  });
  byId("push-left").addEventListener("click", () => push(-1));
  byId("push-right").addEventListener("click", () => push(1));
  refs.addEventListener("input", () => changeReference(refs.value));
  document.querySelectorAll("[data-ref]").forEach(button =>
    button.addEventListener("click", () => changeReference(button.dataset.ref)));
  dynamics.addEventListener("change", reset);
  autoSwing.addEventListener("change", reset);
  byId("apply-initial").addEventListener("click", applyInitial);
  byId("initial-upright").addEventListener("click", () => {
    initial = UPRIGHT_INITIAL.slice();
    setInitialFields(initial);
    byId("initial-error").textContent = "";
    reset();
  });
  byId("initial-downward").addEventListener("click", () => {
    initial = DEFAULT_INITIAL.slice();
    setInitialFields(initial);
    byId("initial-error").textContent = "";
    reset();
  });
  byId("proof-example").addEventListener("click", () => {
    initial = DEFAULT_INITIAL.slice();
    initial[3] = 14;
    setInitialFields(initial);
    byId("initial-error").textContent = "";
    picker.value = "swing";
    renderFields();
    applyController();
    reset();
    byId("simulation").scrollIntoView?.({behavior: "smooth"});
    preparePlayback(startPlayback);
  });
  byId("chart-window").addEventListener("change", draw);
  byId("export").addEventListener("click", exportCsv);
  byId("copy-matrices").addEventListener("click", copyMatrices);
  window.addEventListener("resize", draw);
  setDefaultCustom();
  setInitialFields(initial);
  dynamics.disabled = true;
  autoSwing.disabled = true;
  renderFields();
  showAppliedController();
  writeMatrix(byId("matrix-a"), Plant.A, "矩阵 A");
  writeMatrix(byId("matrix-b"), Plant.B.map(value => [value]), "矩阵 B");
  writePlantParams();
  record();
  updateTransport();
  draw();
})();
