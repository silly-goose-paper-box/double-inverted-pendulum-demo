const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2] ?? path.resolve(__dirname, "../../outputs/double-inverted-pendulum.html"), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const implementation = js.slice(0, js.indexOf('(() => {\n  const byId'));
const { Plant, Control, Expression } = vm.runInNewContext(implementation + "\n({ Plant, Control, Expression })");
const expected = [0, 0.08, -0.06, 0, 0, 0];
const {forceLimit, railLimit} = Plant.params;
const custom = "119.3952*th1 - 152.9691*th2 - 3.1623*ex - 5.8254*v + 0.4434*w1 - 19.6260*w2";
assert.equal(Control.definitions.length, 9);
assert.deepEqual(Array.from(Plant.dynamics([0, 0, 0, 0, 0, 0], 0), value => value + 0), [0, 0, 0, 0, 0, 0]);
assert.equal(Expression.compile("-2^2 + if(0, sqrt(-1), 2^3^2)")(Object.create(null)), 508);
assert.throws(() => Expression.compile("x.constructor"));
const dynamic = Expression.controller("s1 + sin(pi / 2)", ["ex", "0", "0"]);
assert.equal(dynamic.run({z: [1, 0, 0, 0, 0, 0], ref: 0, dt: 0.01, t: 0}), 1);
assert.equal(dynamic.run({z: [1, 0, 0, 0, 0, 0], ref: 0, dt: 0.01, t: 0.01}), 1.01);

function run(controller, usePulse) {
  let state = expected.slice();
  let control = 0;
  let peak = 0;
  let maxX = 0;
  for (let i = 0; i < 2000; i++) {
    const ref = i < 800 ? 0 : 0.25;
    const disturbance = usePulse && i >= 400 && i < 412 ? 8 : 0;
    const output = controller.run({z: state, ref, dt: 0.01, t: i * 0.01, applied: control});
    assert.ok(Number.isFinite(output));
    control = Math.min(forceLimit, Math.max(-forceLimit, output));
    const net = control + disturbance;
    state = Plant.step(Plant.step(state, net, 0.005), net, 0.005);
    assert.ok(state.every(Number.isFinite));
    peak = Math.max(peak, Math.abs(control));
    maxX = Math.max(maxX, Math.abs(state[0]));
    if (maxX >= railLimit) break;
  }
  return {state, peak, maxX};
}

const factories = Control.definitions.filter(definition => definition.id !== "open")
  .map(definition => [definition.id, () => Control.build(definition.id)]);
factories.push(["custom", () => Expression.controller(custom, ["0", "0", "0"])]);
for (const [id, factory] of factories) {
  const step = run(factory(), false);
  assert.ok(step.maxX < railLimit, id + " reached rail in step experiment");
  assert.ok(Math.abs(step.state[0] - 0.25) < 0.003, id + " step position error");
  assert.ok(Math.max(Math.abs(step.state[1]), Math.abs(step.state[2])) < 0.002, id + " step angle error");
  const pulse = run(factory(), true);
  const recover = pulse.maxX < railLimit && Math.abs(pulse.state[0] - 0.25) < 0.003;
  console.log([id, "x=" + step.state[0].toFixed(6), "|u|max=" + step.peak.toFixed(3),
    "pulse=" + (recover ? "recovered" : "rail or error")].join(" "));
}
const open = run(Control.build("open"), false);
assert.equal(open.peak, 0);
assert.ok(Math.max(Math.abs(open.state[1]), Math.abs(open.state[2])) > 0.5);
console.log("PASS: shipped model, nine default feedback variants including custom, open loop, and expression semantics.");
