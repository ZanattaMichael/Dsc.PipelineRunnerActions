'use strict';
// Tests of the CircleCI live tier's configuration generator and result reader.
// Run with:  node --test tests/integration/circleci/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const orbTools = require('../orb.js');
const { ORB, isRefused, jobName, buildConfig, buildRefusedConfig, evaluateCase, evaluateRefusedCase } = require('./config.js');

const casesDirectory = path.join(__dirname, '..', 'cases');
const cases = fs.readdirSync(casesDirectory).sort()
  .filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json')))
  .map((name) => ({ name, definition: JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8')) }));
const accepted = cases.filter(({ definition }) => !isRefused(definition));
const first = cases[0].definition;
const orb = orbTools.readOrb(path.join(__dirname, '..', '..', '..', '..', 'circleci', 'orb.yml'));

test('there are cases; the first is the plain successful run; some are refused by CircleCI', () => {
  assert.ok(cases.length >= 10);
  assert.equal(first.expect.status, 'success');
  assert.ok(accepted.length < cases.length);
});

test('the configuration inlines the orb and has one job per accepted case, all in one workflow', () => {
  const config = YAML.parse(buildConfig(orb, cases, 'abc123'));
  assert.equal(config.version, 2.1);
  assert.ok(config.orbs[ORB].commands.execute, 'the orb is inlined with its execute command');
  assert.ok(!('version' in config.orbs[ORB]) && !('display' in config.orbs[ORB]), 'an inline orb carries no version or display');
  assert.equal(Object.keys(config.jobs).length, accepted.length);
  assert.deepEqual(config.workflows['integration-tests'].jobs, Object.keys(config.jobs));
  for (const [name, job] of Object.entries(config.jobs)) {
    assert.match(name, /^case-\d\d$/);
    assert.equal(job.executor, `${ORB}/default`);
    assert.equal(job.steps[0], 'checkout');
    const command = job.steps.find((step) => step && typeof step === 'object' && `${ORB}/execute` in step);
    assert.ok(command, `${name} does not call the orb command`);
    assert.equal(command[`${ORB}/execute`]['actions-ref'], 'abc123');
    const verify = job.steps[job.steps.length - 1].run;
    assert.equal(verify.name, 'verify');
    assert.equal(verify.when, 'always');
  }
});

test('every job\'s parameters resolve against the real orb command', () => {
  const config = YAML.parse(buildConfig(orb, cases, 'abc123'));
  for (const [name, job] of Object.entries(config.jobs)) {
    const given = job.steps.find((step) => step && typeof step === 'object' && `${ORB}/execute` in step)[`${ORB}/execute`];
    assert.doesNotThrow(() => orbTools.expandCommand(orb, 'execute', given), name);
  }
});

test('a refused case becomes a configuration of its own that the real orb command rejects', () => {
  const index = cases.findIndex(({ definition }) => isRefused(definition));
  const config = YAML.parse(buildRefusedConfig(orb, cases[index].definition, index, 'abc123'));
  assert.deepEqual(Object.keys(config.jobs), [jobName(index)]);
  const given = config.jobs[jobName(index)].steps.find((step) => step && typeof step === 'object' && `${ORB}/execute` in step)[`${ORB}/execute`];
  assert.throws(() => orbTools.expandCommand(orb, 'execute', given));
});

test('secrets are never written into the configuration', () => {
  const yaml = buildConfig(orb, cases, 'abc123');
  for (const { definition } of cases) for (const value of Object.values(definition.context || {})) assert.ok(!yaml.includes(value));
});

const goodOutput = [
  '====>> Dsc.PipelineRunner (Test)', '== Dsc.PipelineRunner: settings', 'Platform: circleci', '====>> verify',
  'DSCPR-OUTPUT DSCPR_STATUS=Completed', 'DSCPR-OUTPUT DSCPR_TOTAL_RESOURCES=3', 'DSCPR-OUTPUT DSCPR_PASS_COUNT=3', 'DSCPR-OUTPUT DSCPR_FAIL_COUNT=0',
  'DSCPR-OUTPUT DSCPR_SKIP_COUNT=0', 'DSCPR-OUTPUT DSCPR_MODULE_VERSION=9.9.9', 'DSCPR-OUTPUT DSCPR_REPORT_PATH=/root/project/dsc-reports',
  'DSCPR-CALL {"Mode":"Test","Engine":"DscV2"}', 'DSCPR-FILE dsc-reports True', 'Success!',
].join('\n');

test('a job that did what the case expects passes', () => {
  assert.deepEqual(evaluateCase(first, goodOutput, 0), []);
});

test('a failed job, a missing output and a wrong call are each named', () => {
  const output = ['Exited with code exit status 1', 'DSCPR-NO-OUTPUTS', 'DSCPR-CALL {"Mode":"Set"}', 'DSCPR-FILE dsc-reports False'].join('\n');
  const failures = evaluateCase(first, output, 1).join('\n');
  assert.match(failures, /the job failed/);
  assert.match(failures, /does not set DSCPR_STATUS \(there is no outputs\.env\)/);
  assert.match(failures, /called with Mode = "Set", expected "Test"/);
  assert.match(failures, /'dsc-reports' does not exist/);
});

test('an expected non-zero exit code must appear in the agent\'s output', () => {
  const definition = { expect: { status: 'failed', exitCode: 2 } };
  assert.deepEqual(evaluateCase(definition, 'Exited with code exit status 2\nDSCPR-NOCALL', 1), []);
  assert.match(evaluateCase(definition, 'Exited with code exit status 1\nDSCPR-NOCALL', 1).join('\n'), /did not exit with 2/);
});

test('a refused case passes only when CircleCI refused it for the expected reason', () => {
  const definition = { expect: { parameterProblems: ['x'], liveParameterProblems: ['mode', 'Apply'] } };
  assert.deepEqual(evaluateRefusedCase(definition, 'Error: ... Expected one of: Test, Set, DryRun; got Apply for parameter mode', 255), []);
  assert.match(evaluateRefusedCase(definition, 'Config file is valid.', 0).join('\n'), /accepted the configuration/);
  assert.match(evaluateRefusedCase(definition, 'something else', 1).join('\n'), /do not match \/mode\//);
});
