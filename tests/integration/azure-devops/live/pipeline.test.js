'use strict';
// Tests of the pipeline generator and of how a finished run is read back.
// Run with:  node --test tests/integration/azure-devops/live/pipeline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TASK_NAME, buildPipelineYaml, collectVariables, evaluateCase, logLines } = require('./pipeline.js');

const casesDirectory = path.join(__dirname, '..', 'cases');
const cases = fs.readdirSync(casesDirectory).sort()
  .filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json')))
  .map((name) => ({ name, definition: JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8')) }));

const stamp = (lines) => lines.map((line) => `2026-01-02T03:04:05.1234567Z ${line}`).join('\n');
// A run in which case 01 did what its case.json expects.
function goodRun(change = {}) {
  const records = [
    { id: 't', type: 'Task', name: 'case 01', result: 'succeeded', issues: [], ...change.task },
    { id: 'v', type: 'Task', name: 'verify 01', result: 'succeeded' },
  ];
  const logs = {
    t: stamp(['##[group]Requirements', 'all good']),
    v: stamp(change.verify || [
      'DSCPR-OUTPUT status=[Completed]', 'DSCPR-OUTPUT total_resources=[3]', 'DSCPR-OUTPUT pass_count=[3]', 'DSCPR-OUTPUT fail_count=[0]',
      'DSCPR-OUTPUT skip_count=[0]', 'DSCPR-OUTPUT module_version=[9.9.9]', 'DSCPR-OUTPUT report_path=[/agent/_work/1/s/dsc-reports]',
      'DSCPR-CALL {"Mode":"Test","Engine":"DscV2"}',
      'DSCPR-FILE dsc-reports/result.json True', 'DSCPR-FILE dsc-reports/outputs.env True',
    ]),
  };
  if (change.taskLog) logs.t = stamp(change.taskLog);
  return { records, logs: (record) => logs[record.id] };
}
const first = cases[0].definition;

test('there are cases, and the first is the plain successful run', () => {
  assert.ok(cases.length >= 10);
  assert.equal(first.expect.result, 'Succeeded');
});

test('the pipeline has a prepare, a task and a verify step for every case, each run whatever came before', () => {
  const yaml = buildPipelineYaml(cases);
  assert.equal((yaml.match(new RegExp(`^- task: ${TASK_NAME}@0$`, 'gm')) || []).length, cases.length);
  assert.equal((yaml.match(/^ {2}displayName: "prepare \d\d"$/gm) || []).length, cases.length);
  assert.equal((yaml.match(/^ {2}displayName: "verify \d\d"$/gm) || []).length, cases.length);
  assert.equal((yaml.match(/^ {2}condition: always\(\)$/gm) || []).length, cases.length * 3);
  assert.match(yaml, /^trigger: none$/m);
  assert.match(yaml, /^ {2}vmImage: "ubuntu-latest"$/m);
  assert.doesNotMatch(yaml, /\t/);
  assert.doesNotMatch(yaml, /\{repo\}|\{workspace\}|\{pathsep\}/);
});

test('a named pool replaces the Microsoft-hosted image', () => {
  const yaml = buildPipelineYaml(cases.slice(0, 1), { pool: 'My Pool' });
  assert.match(yaml, /^ {2}name: "My Pool"$/m);
  assert.doesNotMatch(yaml, /vmImage/);
});

test('secret values are never written into the pipeline file', () => {
  const yaml = buildPipelineYaml(cases);
  for (const value of Object.values(collectVariables(cases, 'secretVariables'))) assert.ok(!yaml.includes(value));
});

test('the case about a variable that is not defined uses a name no case defines', () => {
  const defined = new Set([...Object.keys(collectVariables(cases, 'variables')), ...Object.keys(collectVariables(cases, 'secretVariables'))].map((name) => name.toLowerCase()));
  const undefinedCase = cases.find(({ name }) => name.includes('not-defined'));
  const macros = Object.values(undefinedCase.definition.inputs).join(' ').match(/\$\(([^)]+)\)/g);
  assert.ok(macros.length > 0);
  for (const macro of macros) assert.ok(!defined.has(macro.slice(2, -1).toLowerCase()), `${macro} is defined by another case`);
});

test('two cases may not give one variable two values', () => {
  assert.throws(() => collectVariables([
    { name: 'a', definition: { variables: { X: '1' } } }, { name: 'b', definition: { variables: { X: '2' } } },
  ], 'variables'), /different value/);
});

test('timestamps are taken off log lines', () => {
  assert.deepEqual(logLines('2026-01-02T03:04:05.1234567Z hello\nplain'), ['hello', 'plain']);
});

test('a run that did what the case expects passes', () => {
  const { records, logs } = goodRun();
  assert.deepEqual(evaluateCase(first, 0, records, logs), []);
});

test('a wrong result fails the case', () => {
  const { records, logs } = goodRun({ task: { result: 'failed' } });
  assert.match(evaluateCase(first, 0, records, logs).join('\n'), /result is Failed, expected Succeeded/);
});

test('an output variable that was never set is noticed', () => {
  const { records, logs } = goodRun({ verify: ['DSCPR-OUTPUT status=[$(case01.status)]', 'DSCPR-NOCALL'] });
  const failures = evaluateCase(first, 0, records, logs).join('\n');
  assert.match(failures, /output variable 'status' was not set/);
  assert.match(failures, /output variable 'total_resources' was not set/);
  assert.match(failures, /Dsc\.PipelineRunner was not called/);
  assert.match(failures, /dsc-reports\/result\.json does not exist/);
});

test('a wrong argument in the recorded call is named', () => {
  const run = goodRun();
  const logs = (record) => run.logs(record).replace('"Mode":"Test"', '"Mode":"Set"');
  assert.match(evaluateCase(first, 0, run.records, logs).join('\n'), /called with Mode = "Set", expected "Test"/);
});

test('a missing step is reported, not skipped', () => {
  assert.deepEqual(evaluateCase(first, 0, [], () => ''), ["the run has no step 'case 01'"]);
  const { records, logs } = goodRun();
  assert.match(evaluateCase(first, 0, records.slice(0, 1), logs).join('\n'), /no step 'verify 01'/);
});

test('a masked secret in the log fails a case that has secrets', () => {
  const secretCase = { secretVariables: { T: 'x' }, expect: { result: 'Succeeded' } };
  const { records, logs } = goodRun({ taskLog: ['token is ***'] });
  assert.match(evaluateCase(secretCase, 0, records, logs).join('\n'), /a secret was written to it/);
});

test('issues are matched by type and text', () => {
  const definition = { expect: { result: 'Failed', issues: [{ type: 'error', matches: 'boom' }] } };
  const good = goodRun({ task: { result: 'failed', issues: [{ type: 'error', message: 'it went boom' }] }, verify: ['DSCPR-NOCALL'] });
  assert.deepEqual(evaluateCase(definition, 0, good.records, good.logs), []);
  const wrongType = goodRun({ task: { result: 'failed', issues: [{ type: 'warning', message: 'it went boom' }] }, verify: ['DSCPR-NOCALL'] });
  assert.match(evaluateCase(definition, 0, wrongType.records, wrongType.logs).join('\n'), /no error issue matching/);
});
