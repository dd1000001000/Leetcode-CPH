'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  RESULT_MARKER,
  RUNTIME_MAIN_BASENAME,
  TestcaseRunnerError,
  buildRunPlan,
  formatActualOutput,
  isCompiledLanguage,
  mergeRunResults,
  parseResultLines,
  prepareBuildWorkspace,
  resolveLocalScaffoldPath,
  resolveRuntimeMainPath,
  runAllTestCases,
  runSingleTestCase,
  runTestScaffold,
  safeExecutionEnvironment,
  supportsLanguage
} = require('../vscode-extension/testcase-runner');

const temporaryFolders = [];
afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

async function makeProblem(source, extension = 'js') {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-runner-'));
  temporaryFolders.push(folder);
  const scaffoldPath = path.join(folder, `testcase.${extension}`);
  await fs.writeFile(scaffoldPath, source, 'utf8');
  return { folder, scaffoldPath };
}

async function writeRuntimeSource(folder, extension, source = '') {
  const sourcePath = path.join(folder, 'solution.' + extension);
  await fs.writeFile(sourcePath, source, 'utf8');
  return sourcePath;
}

function fakeChild({ stdout = '', stderr = '', exitCode = 0, signal = null, error } = {}) {
  const child = new EventEmitter();
  child.pid = 0;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.kill = () => true;
  child.start = () => queueMicrotask(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode, signal);
  });
  return child;
}

function assertRunnerError(code) {
  return (error) => {
    assert.ok(error instanceof TestcaseRunnerError);
    assert.equal(error.code, code);
    return true;
  };
}

test('parses JSON-lines testcase results and decorates persisted expected output', () => {
  const parsed = parseResultLines([
    'ordinary diagnostic output',
    `${RESULT_MARKER}{"name":"testcase 001","actual":[0,1],"passed":true}`,
    `  ${RESULT_MARKER} {"name":"testcase 002","actual":"null","error":"example mismatch"}`
  ].join('\n'));

  assert.equal(parsed.markerCount, 2);
  assert.deepEqual({ ...parsed.results }, {
    'testcase 001': { name: 'testcase 001', actual: [0, 1], passed: true },
    'testcase 002': { name: 'testcase 002', actual: 'null', error: 'example mismatch' }
  });
  assert.deepEqual(mergeRunResults([
    { name: 'testcase 001', expectedOutput: '[0,1]' },
    { name: 'testcase 002', expectedOutput: '[]' },
    { name: 'testcase 003', expectedOutput: '1' }
  ], parsed.results), [
    { name: 'testcase 001', expectedOutput: '[0,1]', hasRunResult: true, actualOutput: '[0,1]', passed: true },
    { name: 'testcase 002', expectedOutput: '[]', hasRunResult: true, actualOutput: '"null"', runError: 'example mismatch' },
    { name: 'testcase 003', expectedOutput: '1', hasRunResult: false }
  ]);
  assert.equal(formatActualOutput('hello'), '"hello"');
});

test('rejects malformed or duplicate result protocol lines', () => {
  assert.throws(
    () => parseResultLines(`${RESULT_MARKER}{"name":"testcase 001"}`),
    assertRunnerError('INVALID_RESULT_PROTOCOL')
  );
  assert.throws(
    () => parseResultLines(`${RESULT_MARKER}{"name":"testcase 001","actual":1}\n${RESULT_MARKER}{"name":"testcase 001","actual":2}`),
    assertRunnerError('DUPLICATE_RESULT')
  );
});

test('builds fixed shell-free plans for JavaScript and Python', () => {
  const js = buildRunPlan({
    scaffoldPath: '/safe/problem/testcase.js',
    language: 'javascript',
    mode: 'case',
    caseName: 'testcase 001',
    nodePath: '/node'
  });
  assert.equal(js.command, '/node');
  assert.deepEqual(js.args, ['/safe/problem/testcase.js', '--case', 'testcase 001']);
  assert.deepEqual(js.environment, { ELECTRON_RUN_AS_NODE: '1' });

  const python = buildRunPlan({
    scaffoldPath: 'C:\\safe\\problem\\testcase.py',
    language: 'python',
    mode: 'all',
    platform: 'win32'
  });
  assert.equal(python.command, 'py');
  assert.deepEqual(python.args, ['-3', 'C:\\safe\\problem\\testcase.py']);
});

test('builds adapters for every supported CPH language and rejects SQL', () => {
  const languages = [
    ['c', 'c', true],
    ['cpp', 'cpp', true],
    ['csharp', 'cs', true],
    ['rust', 'rs', true],
    ['go', 'go', true],
    ['haskell', 'hs', true],
    ['python', 'py', false],
    ['ruby', 'rb', false],
    ['java', 'java', true],
    ['javascript', 'js', false],
    ['typescript', 'ts', true],
    ['kotlin', 'kt', true],
    ['swift', 'swift', true],
    ['php', 'php', false],
    ['scala', 'scala', true]
  ];
  for (const [language, extension, compiled] of languages) {
    const plan = buildRunPlan({
      scaffoldPath: '/safe/problem/main.' + extension,
      language,
      nodePath: '/node'
    });
    assert.equal(plan.language, language);
    assert.equal(plan.compileSteps.length > 0, compiled, language);
    assert.ok(plan.runStep.candidates.length > 0, language);
    assert.equal(supportsLanguage(language), true, language);
    assert.equal(isCompiledLanguage(language), compiled, language);
  }
  assert.equal(supportsLanguage('.sql'), false);
  assert.throws(
    () => buildRunPlan({ scaffoldPath: '/safe/problem/main.sql' }),
    assertRunnerError('UNSUPPORTED_LANGUAGE')
  );
});

test('prepares compiler output directories required by Java, Scala, and Haskell', async () => {
  for (const extension of ['java', 'scala', 'hs']) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-${extension}-prepare-`));
    temporaryFolders.push(folder);
    const scaffoldPath = path.join(folder, `main.${extension}`);
    const solutionPath = path.join(folder, `solution.${extension}`);
    await Promise.all([
      fs.writeFile(scaffoldPath, '// main\n', 'utf8'),
      fs.writeFile(solutionPath, extension === 'hs' ? 'module Solution where\n' : '// solution\n', 'utf8')
    ]);
    const location = await resolveLocalScaffoldPath(folder, scaffoldPath);
    const build = await prepareBuildWorkspace(location, { solutionPath });
    try {
      const expected = extension === 'java' ? 'java-classes' : extension === 'scala' ? 'scala-classes' : 'ghc-out';
      assert.equal((await fs.stat(path.join(build.buildDirectory, expected))).isDirectory(), true);
      if (extension === 'java') {
        assert.equal(path.basename(build.sourcePath), 'Solution.java');
        assert.match(await fs.readFile(build.sourcePath, 'utf8'), /import java\.util\.\*;/);
      }
    } finally {
      await fs.rm(build.buildDirectory, { recursive: true, force: true });
    }
  }
});

test('stages script-style JavaScript solution declarations with main in one entry', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-js-entry-'));
  temporaryFolders.push(folder);
  const scaffoldPath = path.join(folder, 'main.js');
  const solutionPath = path.join(folder, 'solution.js');
  await Promise.all([
    fs.writeFile(solutionPath, 'const add = (left, right) => left + right;\n', 'utf8'),
    fs.writeFile(scaffoldPath, [
      'const actual = add(1, 2);',
      `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ name: 'testcase 001', actual, passed: actual === 3 }));`
    ].join('\n'), 'utf8')
  ]);

  const result = await runAllTestCases({
    problemFolder: folder,
    scaffoldPath,
    solutionPath,
    expectedCaseNames: ['testcase 001']
  });
  assert.equal(result.ok, true);
  assert.equal(result.results['testcase 001'].actual, 3);
});

test('keeps module-style JavaScript scaffolds and prepares TypeScript and Python platform shims', async () => {
  const fixtures = [
    {
      extension: 'js',
      solution: 'module.exports = (value) => value + 1;\n',
      main: "const solve = require('./solution');\nvoid solve;\n"
    },
    {
      extension: 'ts',
      solution: 'const add = (left: number, right: number): number => left + right;\n',
      main: 'void process.argv;\nvoid add;\n'
    },
    {
      extension: 'py',
      solution: 'class Solution:\n    def first(self):\n        values = []\n        heappush(values, 2)\n        heappush(values, 1)\n        return heappop(values)\n',
      main: 'from solution import Solution\n'
    }
  ];

  for (const fixture of fixtures) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), `leetcode-cph-${fixture.extension}-shims-`));
    temporaryFolders.push(folder);
    const scaffoldPath = path.join(folder, `main.${fixture.extension}`);
    const solutionPath = path.join(folder, `solution.${fixture.extension}`);
    await Promise.all([
      fs.writeFile(solutionPath, fixture.solution, 'utf8'),
      fs.writeFile(scaffoldPath, fixture.main, 'utf8')
    ]);
    const location = await resolveLocalScaffoldPath(folder, scaffoldPath);
    const build = await prepareBuildWorkspace(location, { solutionPath });
    try {
      const entry = await fs.readFile(build.entryPath, 'utf8');
      if (fixture.extension === 'js') {
        assert.equal(build.entryPath, build.scaffoldPath);
        assert.match(entry, /require\('\.\/solution'\)/);
      } else if (fixture.extension === 'ts') {
        assert.match(entry, /^declare const process:/);
        assert.ok(entry.indexOf('const add') < entry.indexOf('void add'));
      } else {
        assert.match(entry, /\(typing, collections, functools, itertools, math, heapq, bisect\)/);
        assert.match(entry, /setattr\(builtins, _name, getattr\(_module, _name\)\)/);
        assert.match(entry, /runpy\.run_path/);
      }
    } finally {
      await fs.rm(build.buildDirectory, { recursive: true, force: true });
    }
  }
});

test('stages LeetCode Go function snippets as package main without changing the user file', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-go-prepare-'));
  temporaryFolders.push(folder);
  const scaffoldPath = path.join(folder, 'main.go');
  const solutionPath = path.join(folder, 'solution.go');
  const solution = 'func add(a int, b int) int { return a + b }\n';
  await Promise.all([
    fs.writeFile(scaffoldPath, 'package main\nfunc main() {}\n', 'utf8'),
    fs.writeFile(solutionPath, solution, 'utf8')
  ]);
  const location = await resolveLocalScaffoldPath(folder, scaffoldPath);
  const build = await prepareBuildWorkspace(location, { solutionPath });
  try {
    assert.equal(await fs.readFile(build.sourcePath, 'utf8'), `package main\n\n${solution}`);
    assert.equal(await fs.readFile(solutionPath, 'utf8'), solution);
  } finally {
    await fs.rm(build.buildDirectory, { recursive: true, force: true });
  }
});

test('uses a minimal execution environment rather than forwarding extension-host secrets', () => {
  const secretName = 'LEETCODE_CPH_TEST_ONLY_SECRET';
  const previous = process.env[secretName];
  process.env[secretName] = 'must-not-reach-scaffold';
  try {
    const environment = safeExecutionEnvironment({ ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(environment[secretName], undefined);
    assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(environment.PYTHONNOUSERSITE, '1');
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test('refuses to run a scaffold whose disk content changed after confirmation', async () => {
  const { folder, scaffoldPath } = await makeProblem("console.log('old scaffold');");
  const approvedHash = crypto.createHash('sha256').update(await fs.readFile(scaffoldPath)).digest('hex');
  await fs.writeFile(scaffoldPath, "console.log('replacement scaffold');", 'utf8');
  await assert.rejects(
    runAllTestCases({ problemFolder: folder, scaffoldPath, expectedScaffoldHash: approvedHash }),
    assertRunnerError('SCAFFOLD_CHANGED')
  );
});

test('permits main.<ext> and migration testcase.<ext> only inside the problem directory', async () => {
  const { folder, scaffoldPath } = await makeProblem('// scaffold');
  const location = await resolveLocalScaffoldPath(folder, scaffoldPath);
  assert.equal(location.scaffoldPath, await fs.realpath(scaffoldPath));
  assert.equal(location.language, 'javascript');

  const outside = path.join(path.dirname(folder), 'testcase.js');
  await fs.writeFile(outside, '// outside', 'utf8');
  try {
    await assert.rejects(
      resolveLocalScaffoldPath(folder, outside),
      assertRunnerError('SCAFFOLD_OUTSIDE_PROBLEM')
    );
  } finally {
    await fs.rm(outside, { force: true });
  }

  const notScaffold = path.join(folder, 'solution.js');
  await fs.writeFile(notScaffold, '// not a scaffold', 'utf8');
  await assert.rejects(
    resolveLocalScaffoldPath(folder, notScaffold),
    assertRunnerError('INVALID_SCAFFOLD_NAME')
  );

  const mainPath = path.join(folder, RUNTIME_MAIN_BASENAME + '.cpp');
  await fs.writeFile(mainPath, '// main scaffold', 'utf8');
  const mainLocation = await resolveLocalScaffoldPath(folder, mainPath);
  assert.equal(mainLocation.language, 'cpp');
  assert.equal(mainLocation.legacyName, false);
  const runtimeSource = await writeRuntimeSource(folder, 'cpp', '// solution');
  const runtime = await resolveRuntimeMainPath(folder, 'cpp');
  assert.equal(runtime.filePath, await fs.realpath(runtimeSource));
});

test('rejects a testcase symlink that resolves outside the problem directory', async (t) => {
  const { folder } = await makeProblem('// ordinary scaffold');
  const outsideFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-cph-runner-outside-'));
  temporaryFolders.push(outsideFolder);
  const outside = path.join(outsideFolder, 'outside.js');
  const linked = path.join(folder, 'testcase.js');
  await fs.writeFile(outside, '// outside target', 'utf8');
  try {
    await fs.rm(linked);
    await fs.symlink(outside, linked, 'file');
  } catch (error) {
    // Some locked-down Windows installations disallow creating file symlinks;
    // the production check is still covered by the path implementation.
    t.skip(`file symlinks are unavailable here: ${error.code || error.message}`);
    return;
  }
  await assert.rejects(
    resolveLocalScaffoldPath(folder, linked),
    assertRunnerError('SCAFFOLD_OUTSIDE_PROBLEM')
  );
});

test('runs a JavaScript scaffold once per selected case or all cases without a shell', async () => {
  const source = [
    `const marker = ${JSON.stringify(RESULT_MARKER)};`,
    "const selector = process.argv.indexOf('--case');",
    "const selected = selector < 0 ? null : process.argv[selector + 1];",
    "const names = ['testcase 001', 'testcase 002'];",
    'for (const name of names) {',
    '  if (selected && selected !== name) continue;',
    "  console.log(marker + JSON.stringify({ name, actual: name === 'testcase 001' ? [0, 1] : '42', passed: true }));",
    '}'
  ].join('\n');
  const { folder, scaffoldPath } = await makeProblem(source);
  let observed;
  const spawnImpl = (command, args, options) => {
    observed = { command, args, options };
    return childProcess.spawn(command, args, options);
  };

  const all = await runAllTestCases({ problemFolder: folder, scaffoldPath, spawnImpl });
  assert.equal(all.ok, true);
  assert.deepEqual(Object.keys(all.results), ['testcase 001', 'testcase 002']);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.cwd, await fs.realpath(folder));
  assert.deepEqual(observed.args, [await fs.realpath(scaffoldPath)]);

  const one = await runSingleTestCase({ problemFolder: folder, scaffoldPath }, 'testcase 002');
  assert.equal(one.ok, true);
  assert.deepEqual({ ...one.results }, {
    'testcase 002': { name: 'testcase 002', actual: '42', passed: true }
  });
});

test('passes a hostile-looking testcase name as an argument rather than shell code', async () => {
  const source = [
    `const marker = ${JSON.stringify(RESULT_MARKER)};`,
    "const selector = process.argv.indexOf('--case');",
    'const name = process.argv[selector + 1];',
    'console.log(marker + JSON.stringify({ name, actual: process.argv.slice(2).join("|") }));'
  ].join('\n');
  const { folder, scaffoldPath } = await makeProblem(source);
  const name = 'testcase 001; echo should-not-run';
  const result = await runSingleTestCase({ problemFolder: folder, scaffoldPath }, name);
  assert.equal(result.results[name].actual, `--case|${name}`);
});

test('returns emitted results alongside a non-zero runtime exit', async () => {
  const source = [
    `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ name: 'testcase 001', actual: 'wrong', passed: false }));`,
    "console.error('assertion failed');",
    'process.exit(7);'
  ].join('\n');
  const { folder, scaffoldPath } = await makeProblem(source);
  const result = await runAllTestCases({ problemFolder: folder, scaffoldPath });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.results['testcase 001'].actual, 'wrong');
  assert.match(result.error, /退出码 7/);
});

test('compiles and runs C++ in separate shell-free temporary phases, then removes build output', async () => {
  const { folder } = await makeProblem('// legacy scaffold', 'cpp');
  const scaffoldPath = path.join(folder, RUNTIME_MAIN_BASENAME + '.cpp');
  await fs.writeFile(scaffoldPath, '// main test entry', 'utf8');
  await writeRuntimeSource(folder, 'cpp', '// solution source');
  const calls = [];
  const children = [
    fakeChild({
      stdout: RESULT_MARKER + JSON.stringify({ name: 'wrong compile output', actual: 'ignore' }) + '\n'
    }),
    fakeChild({
      stdout: RESULT_MARKER + JSON.stringify({ name: 'testcase 001', actual: 42, passed: true }) + '\n'
    })
  ];
  const result = await runSingleTestCase({
    problemFolder: folder,
    scaffoldPath,
    expectedCaseNames: ['testcase 001'],
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = children.shift();
      child.start();
      return child;
    }
  }, 'testcase 001');

  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.results }, {
    'testcase 001': { name: 'testcase 001', actual: 42, passed: true }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[0].options.cwd, calls[1].options.cwd);
  assert.notEqual(calls[0].options.cwd, await fs.realpath(folder));
  assert.deepEqual(calls[1].args.slice(-2), ['--case', 'testcase 001']);
  await assert.rejects(
    fs.stat(calls[0].options.cwd),
    (error) => error?.code === 'ENOENT'
  );
});

test('reports compiler failures and missing compilers while always cleaning the temporary build directory', async () => {
  const failed = await makeProblem('// legacy scaffold', 'cpp');
  const failedMain = path.join(failed.folder, RUNTIME_MAIN_BASENAME + '.cpp');
  await fs.writeFile(failedMain, '// main test entry', 'utf8');
  await writeRuntimeSource(failed.folder, 'cpp', '// solution source');
  const failedCalls = [];
  await assert.rejects(
    runAllTestCases({
      problemFolder: failed.folder,
      scaffoldPath: failedMain,
      spawnImpl: (command, args, options) => {
        failedCalls.push({ command, args, options });
        const child = fakeChild({ stderr: 'syntax error', exitCode: 1 });
        child.start();
        return child;
      }
    }),
    (error) => {
      assertRunnerError('COMPILE_FAILED')(error);
      assert.match(error.message, /编译/);
      assert.match(error.message, /syntax error/);
      return true;
    }
  );
  assert.equal(failedCalls.length, 1);
  await assert.rejects(
    fs.stat(failedCalls[0].options.cwd),
    (error) => error?.code === 'ENOENT'
  );

  const unavailable = await makeProblem('// legacy scaffold', 'cpp');
  const unavailableMain = path.join(unavailable.folder, RUNTIME_MAIN_BASENAME + '.cpp');
  await fs.writeFile(unavailableMain, '// main test entry', 'utf8');
  await writeRuntimeSource(unavailable.folder, 'cpp', '// solution source');
  const unavailableCalls = [];
  await assert.rejects(
    runAllTestCases({
      problemFolder: unavailable.folder,
      scaffoldPath: unavailableMain,
      spawnImpl: (command, args, options) => {
        unavailableCalls.push({ command, args, options });
        const error = new Error('not found');
        error.code = 'ENOENT';
        const child = fakeChild({ error });
        child.start();
        return child;
      }
    }),
    (error) => {
      assertRunnerError('COMPILER_UNAVAILABLE')(error);
      assert.match(error.message, /安装|PATH/);
      return true;
    }
  );
  assert.equal(unavailableCalls.length, 2);
  await assert.rejects(
    fs.stat(unavailableCalls[0].options.cwd),
    (error) => error?.code === 'ENOENT'
  );
});

test('rejects missing or extra protocol results for an exact sidebar request', async () => {
  const missing = await makeProblem([
    `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ name: 'testcase 001', actual: 1, passed: true }));`
  ].join('\n'));
  await assert.rejects(
    runAllTestCases({
      problemFolder: missing.folder,
      scaffoldPath: missing.scaffoldPath,
      expectedCaseNames: ['testcase 001', 'testcase 002']
    }),
    (error) => {
      assertRunnerError('RESULT_SET_MISMATCH')(error);
      assert.match(error.stdout, /testcase 001/);
      return true;
    }
  );

  const extra = await makeProblem([
    `const marker = ${JSON.stringify(RESULT_MARKER)};`,
    "console.log(marker + JSON.stringify({ name: 'testcase 001', actual: 1, passed: true }));",
    "console.log(marker + JSON.stringify({ name: 'testcase 002', actual: 2, passed: true }));"
  ].join('\n'));
  await assert.rejects(
    runSingleTestCase({ problemFolder: extra.folder, scaffoldPath: extra.scaffoldPath }, 'testcase 001'),
    assertRunnerError('RESULT_SET_MISMATCH')
  );
});

test('reports a missing protocol, output limit, and unsupported language explicitly', async () => {
  const missing = await makeProblem("console.log('no marker');");
  await assert.rejects(
    runAllTestCases({ problemFolder: missing.folder, scaffoldPath: missing.scaffoldPath }),
    (error) => {
      assertRunnerError('MISSING_RESULT_PROTOCOL')(error);
      assert.match(error.stdout, /no marker/);
      return true;
    }
  );

  const noisy = await makeProblem(`console.log('x'.repeat(5000));`);
  await assert.rejects(
    runAllTestCases({ problemFolder: noisy.folder, scaffoldPath: noisy.scaffoldPath, maxOutputBytes: 64 }),
    assertRunnerError('OUTPUT_LIMIT_EXCEEDED')
  );

  const sql = await makeProblem('-- SQL scaffold', 'sql');
  await assert.rejects(
    runAllTestCases({ problemFolder: sql.folder, scaffoldPath: sql.scaffoldPath }),
    assertRunnerError('UNSUPPORTED_LANGUAGE')
  );
});

test('enforces an execution timeout and turns a missing runtime into an actionable error', async () => {
  const hanging = await makeProblem('setInterval(() => {}, 1_000);');
  await assert.rejects(
    runAllTestCases({ problemFolder: hanging.folder, scaffoldPath: hanging.scaffoldPath, timeoutMs: 100 }),
    assertRunnerError('EXECUTION_TIMEOUT')
  );

  const python = await makeProblem('# Python scaffold', 'py');
  await assert.rejects(
    runAllTestCases({
      problemFolder: python.folder,
      scaffoldPath: python.scaffoldPath,
      spawnImpl: () => {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
    }),
    assertRunnerError('RUNTIME_UNAVAILABLE')
  );
});

test('settles a timed-out run even if a child leaves its output pipes open', async () => {
  const { folder, scaffoldPath } = await makeProblem('// scaffold');
  const child = new EventEmitter();
  child.pid = 0;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.kill = () => true;
  let observed;
  const startedAt = Date.now();

  await assert.rejects(
    runTestScaffold({
      problemFolder: folder,
      scaffoldPath,
      timeoutMs: 20,
      platform: 'linux',
      spawnImpl: (command, args, options) => {
        observed = { command, args, options };
        return child;
      }
    }),
    assertRunnerError('EXECUTION_TIMEOUT')
  );

  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.shell, false);
  assert.ok(Date.now() - startedAt < 1_500, 'forced settlement should not wait for a never-closing child');
});
