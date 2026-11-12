const Expression = (() => {
  const variables = new Set(["x", "th1", "th2", "v", "w1", "w2", "r", "ex", "t", "dt", "s1", "s2", "s3"]);
  const constants = new Map([["pi", Math.PI], ["e", Math.E]]);
  const functions = new Map([
    ...["sin", "cos", "tan", "asin", "acos", "atan", "tanh", "abs", "sign", "sqrt", "exp", "log", "floor", "ceil"]
      .map(name => [name, { min: 1, max: 1, fn: Math[name] }]),
    ["atan2", { min: 2, max: 2, fn: Math.atan2 }],
    ["pow", { min: 2, max: 2, fn: Math.pow }],
    ["min", { min: 2, max: 8, fn: Math.min }],
    ["max", { min: 2, max: 8, fn: Math.max }],
    ["clamp", { min: 3, max: 3, fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) }],
    ["if", { min: 3, max: 3 }],
  ]);
  const binary = new Map([
    ["||", [1, (a, b) => Number(Boolean(a || b()))]],
    ["&&", [2, (a, b) => Number(Boolean(a && b()))]],
    ["==", [3, (a, b) => Number(a === b())]],
    ["!=", [3, (a, b) => Number(a !== b())]],
    ["<", [4, (a, b) => Number(a < b())]],
    ["<=", [4, (a, b) => Number(a <= b())]],
    [">", [4, (a, b) => Number(a > b())]],
    [">=", [4, (a, b) => Number(a >= b())]],
    ["+", [5, (a, b) => a + b()]],
    ["-", [5, (a, b) => a - b()]],
    ["*", [6, (a, b) => a * b()]],
    ["/", [6, (a, b) => a / b()]],
    ["^", [8, (a, b) => a ** b()]],
    ["**", [8, (a, b) => a ** b()]],
  ]);

  function compile(source) {
    const input = source.trim();
    if (input.length === 0 || input.length > 500) {
      throw new Error("表达式应包含 1 至 500 个字符");
    }
    const tokenizer = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z][a-zA-Z0-9]*|\*\*|<=|>=|==|!=|&&|\|\||[()+\-*/^,<>!]/gy;
    const tokens = [];
    let offset = 0;
    while (offset < input.length) {
      const match = tokenizer.exec(input);
      if (!match) throw new Error("无法识别字符「" + input[offset] + "」");
      if (match[0].trim()) tokens.push(match[0]);
      offset = tokenizer.lastIndex;
    }
    let index = 0;

    function expect(token) {
      if (tokens[index] !== token) throw new Error("此处需要「" + token + "」");
      index += 1;
    }

    function atom() {
      const token = tokens[index++];
      if (token === undefined) throw new Error("表达式未结束");
      if (token === "(") {
        const inner = parse(0);
        expect(")");
        return inner;
      }
      if (token === "+" || token === "-" || token === "!") {
        const operand = parse(7);
        if (token === "-") return env => -operand(env);
        if (token === "!") return env => Number(!operand(env));
        return operand;
      }
      if (/^[0-9.]/.test(token)) {
        const value = Number(token);
        if (!Number.isFinite(value)) throw new Error("数值超出范围");
        return () => value;
      }
      if (constants.has(token)) return () => constants.get(token);
      if (variables.has(token)) return env => env[token];
      const entry = functions.get(token);
      if (!entry) throw new Error("未知变量或函数「" + token + "」");
      expect("(");
      const args = [];
      if (tokens[index] !== ")") {
        args.push(parse(0));
        while (tokens[index] === ",") {
          index += 1;
          args.push(parse(0));
        }
      }
      expect(")");
      if (args.length < entry.min || args.length > entry.max) {
        throw new Error("函数 " + token + " 的参数个数有误");
      }
      if (token === "if") return env => args[0](env) ? args[1](env) : args[2](env);
      return env => entry.fn(...args.map(arg => arg(env)));
    }

    function parse(minPrecedence) {
      let left = atom();
      while (binary.has(tokens[index])) {
        const op = tokens[index];
        const [precedence, evaluate] = binary.get(op);
        if (precedence < minPrecedence) break;
        index += 1;
        const right = parse(precedence + (op === "^" || op === "**" ? 0 : 1));
        const previous = left;
        left = env => evaluate(previous(env), () => right(env));
      }
      return left;
    }

    const evaluate = parse(0);
    if (index < tokens.length) throw new Error("「" + tokens[index] + "」前可能缺少运算符");
    return evaluate;
  }

  function controller(forceSource, stateSources) {
    const force = compile(forceSource);
    const rates = stateSources.map(compile);
    let states = [0, 0, 0];
    return {
      detail: "已编译 u 与三条内部状态微分方程。内部状态会在重置时归零。",
      run({z, ref, t, dt}) {
        const [x, th1, th2, v, w1, w2] = z;
        const [s1, s2, s3] = states;
        const env = {x, th1, th2, v, w1, w2, r: ref, ex: x - ref, t, dt, s1, s2, s3};
        const output = force(env);
        const next = rates.map((rate, i) => states[i] + dt * rate(env));
        if (!Number.isFinite(output) || next.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) {
          throw new Error("控制律产生非有限输出，或内部状态超出数值范围");
        }
        states = next;
        return output;
      },
    };
  }

  return Object.freeze({compile, controller});
})();
