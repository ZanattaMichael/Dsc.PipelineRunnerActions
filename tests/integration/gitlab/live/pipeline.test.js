'use strict';
// Tests of the GitLab live tier's pipeline generator and result reader.
// Run with:  node --test tests/integration/gitlab/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const component = require('../component.js');
const { isRefused, buildPipeline, buildRefusedPipeline, cleanTrace, evaluateCase, evaluateRefusedCase } = require('./pipeline.js');

const casesDirectory = path.join(__dirname, '..', 'cases');
const cases = fs.readdirSync(casesDirectory).sort()
  .filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json')))
  .map((name) => ({ name, definition: JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8')) }));
const accepted = cases.filter(({ definition }) => !isRefused(definition));
const first = cases[0].definition;
const COMPONENT = 'gitlab.example.test/root/project/dsc-pipeline-runner';

test('there are cases; the first is the plain successful run; some are refused by GitLab', () => {
  assert.ok(cases.length >= 10);
  assert.equal(first.expect.status, 'success');
  assert.ok(accepted.length < cases.length);
});

test('every accepted case becomes an include and two jobs, and the refused ones are left out', () => {
  const pipeline = YAML.parse(buildPipeline(cases, COMPONENT));
  assert.deepEqual(pipeline.stages, ['test', 'verify']);
  assert.equal(pipeline.include.length, accepted.length);
  for (const include of pipeline.include) {
    assert.equal(include.component, `${COMPONENT}@$CI_COMMIT_SHA`);
    assert.match(include.inputs.job_name, /^case-\d\d$/);
    assert.ok(pipeline[include.inputs.job_name], `no job ${include.inputs.job_name}`);
    const verify = pipeline[include.inputs.job_name.replace('case', 'verify')];
    assert.equal(verify.stage, 'verify');
    assert.equal(verify.when, 'always');
    assert.deepEqual(verify.needs, [{ job: include.inputs.job_name, artifacts: true }]);
  }
  assert.ok(!Object.keys(pipeline).some((key) => key === 'case-04' || key === 'case-05'));
});

test('every include resolves against the real component, and the merged job passes the editor checks', () => {
  const template = component.readTemplate(path.join(__dirname, '..', '..', '..', '..', 'templates', 'dsc-pipeline-runner.yml'));
  const pipeline = YAML.parse(buildPipeline(cases, COMPONENT));
  for (const include of pipeline.include) {
    const built = component.buildJob(template, include.inputs, { [include.inputs.job_name]: pipeline[include.inputs.job_name] }, pipeline.stages);
    assert.deepEqual(built.problems, [], include.inputs.job_name);
    assert.equal(built.job.variables.DSCPR_CORE_URL, '$CI_SERVER_URL/$CI_PROJECT_PATH/-/raw/$CI_COMMIT_SHA/core/');
    assert.match(built.job.variables.DSCPR_TEST_CALL_FILE, /call\.json$/);
  }
});

test('a case without PowerShell gets an image that has none', () => {
  const pipeline = YAML.parse(buildPipeline(cases, COMPONENT));
  const index = cases.findIndex(({ definition }) => definition.hidePowerShell);
  assert.ok(index >= 0);
  const include = pipeline.include.find((candidate) => candidate.inputs.job_name === `case-${String(index + 1).padStart(2, '0')}`);
  assert.equal(include.inputs.image, 'alpine:3.20');
});

test('a refused case becomes a pipeline of its own', () => {
  const index = cases.findIndex(({ definition }) => isRefused(definition));
  const pipeline = YAML.parse(buildRefusedPipeline(cases[index].definition, index, COMPONENT, 'abc'));
  assert.equal(pipeline.include.length, 1);
  assert.equal(pipeline.include[0].component, `${COMPONENT}@abc`);
});

test('secrets are never written into the pipeline file', () => {
  const yaml = buildPipeline(cases, COMPONENT);
  for (const { definition } of cases) for (const value of Object.values(definition.maskedVariables || {})) assert.ok(!yaml.includes(value));
});

test('traces are cleaned of colour codes, section markers and the per-line timestamp prefix', () => {
  assert.equal(cleanTrace('\x1b[0;32m$ echo hi\x1b[0;m\r\nsection_start:1700000000:step_script\rhi\n'), '$ echo hi\nhi\n');
  assert.equal(cleanTrace('2026-11-18T02:24:46.049679Z 01O $ echo hi\n2026-11-18T02:24:46.049680Z 01O DSCPR-OUTPUT X=[1]\n2026-11-18T02:24:46.599933Z 00O+Uploading artifacts for successful job\n2026-11-18T02:24:47.514102Z 01E dsc-reports: found 4\n'), '$ echo hi\nDSCPR-OUTPUT X=[1]\nUploading artifacts for successful job\ndsc-reports: found 4\n');
});

test('a verify job whose trace carries the timestamp prefix is still read', () => {
  const { jobs, traces } = goodRun();
  const stamped = (job) => traces(job).split('\n').map((line) => `2026-11-18T02:24:46.049679Z 01O ${line}`).join('\n');
  assert.deepEqual(evaluateCase(first, 0, jobs, stamped), []);
});

const verifyLines = [
  'DSCPR-OUTPUT DSCPR_STATUS=[Completed]', 'DSCPR-OUTPUT DSCPR_TOTAL_RESOURCES=[3]', 'DSCPR-OUTPUT DSCPR_PASS_COUNT=[3]', 'DSCPR-OUTPUT DSCPR_FAIL_COUNT=[0]',
  'DSCPR-OUTPUT DSCPR_SKIP_COUNT=[0]', 'DSCPR-OUTPUT DSCPR_MODULE_VERSION=[9.9.9]', 'DSCPR-OUTPUT DSCPR_REPORT_PATH=[/builds/root/p/dsc-reports]',
  'DSCPR-CALL {"Mode":"Test","Engine":"DscV2"}', 'DSCPR-FILE dsc-reports True',
];
function goodRun(change = {}) {
  const jobs = [{ id: 1, name: 'case-01', status: 'success', ...change.job }, { id: 2, name: 'verify-01', status: 'success' }];
  const traces = { 1: change.caseTrace || '== Dsc.PipelineRunner: settings\nPlatform: gitlab\nJob succeeded', 2: (change.verify || verifyLines).join('\n') };
  return { jobs, traces: (job) => traces[job.id] };
}

test('a pipeline that did what the case expects passes', () => {
  const { jobs, traces } = goodRun();
  assert.deepEqual(evaluateCase(first, 0, jobs, traces), []);
});

test('a wrong status, a missing dotenv variable and a wrong call are each named', () => {
  const wrong = goodRun({ job: { status: 'failed' }, verify: ['DSCPR-OUTPUT DSCPR_STATUS=[]', 'DSCPR-CALL {"Mode":"Set"}', 'DSCPR-FILE dsc-reports False'] });
  const failures = evaluateCase(first, 0, wrong.jobs, wrong.traces).join('\n');
  assert.match(failures, /status is failed, expected success/);
  assert.match(failures, /does not set DSCPR_STATUS/);
  assert.match(failures, /called with Mode = "Set", expected "Test"/);
  assert.match(failures, /'dsc-reports' was not passed on/);
});

test('a masked secret in the trace fails a case with masked variables', () => {
  const definition = { maskedVariables: { T: 'x' }, expect: { status: 'success' } };
  const { jobs, traces } = goodRun({ caseTrace: 'token [MASKED]', verify: ['DSCPR-NOCALL'] });
  assert.match(evaluateCase(definition, 0, jobs, traces).join('\n'), /a secret was written to it/);
});

test('the exit code is read from the runner\'s last line', () => {
  const definition = { expect: { status: 'failed', exitCode: 2 } };
  const { jobs, traces } = goodRun({ job: { status: 'failed' }, caseTrace: 'ERROR: Job failed: exit code 2', verify: ['DSCPR-NOCALL'] });
  assert.deepEqual(evaluateCase(definition, 0, jobs, traces), []);
  const other = goodRun({ job: { status: 'failed' }, caseTrace: 'ERROR: Job failed: exit code 1', verify: ['DSCPR-NOCALL'] });
  assert.match(evaluateCase(definition, 0, other.jobs, other.traces).join('\n'), /exit code is 1, expected 2/);
});

test('a missing job is reported, not skipped', () => {
  assert.deepEqual(evaluateCase(first, 0, [], () => ''), ["the pipeline has no job 'case-01'"]);
});

test('a refused case passes only when GitLab refused it for the expected reason', () => {
  const definition = { expect: { inputProblems: ['x'], liveInputProblems: ['mode', 'Apply'] } };
  assert.deepEqual(evaluateRefusedCase(definition, { valid: false, errors: ['`mode` input: `Apply` is not one of the allowed options'] }), []);
  assert.match(evaluateRefusedCase(definition, { valid: true, errors: [] }).join('\n'), /accepted the pipeline/);
  assert.match(evaluateRefusedCase(definition, { valid: false, errors: ['something else'] }).join('\n'), /do not match \/mode\//);
});
