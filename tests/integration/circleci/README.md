# CircleCI integration tests

Two tiers run the same cases (`cases/*/case.json`) against the CircleCI orb.

| Tier | What is real | What is a stand-in | Runs |
| --- | --- | --- | --- |
| **Processing and agent contract** (`run-cases.js`) | The orb, PowerShell 7, the fetch of the step script from GitHub, the step script | CircleCI's processing of the orb command (`orb.js`) and the build agent (`agent.js`); Dsc.PipelineRunner (`tests/fixtures/modules`) | In CI on every push from this repository, on Linux (bash) and Windows (PowerShell) |
| **Live** (`live/run-local-execute.js`) | CircleCI's processing of the configuration with the orb inlined (`circleci config validate`), the build agent and the executor image (`circleci local execute`), the fetch, the step script | Dsc.PipelineRunner; contexts (secrets are passed with `--env`) | In CI on every push from this repository, if the CLI processes the configuration without a token or the secret `CIRCLECI_TOKEN` is set |

The stand-in module records the arguments it was called with, so a case can check what reached
it, and no DSC resources are needed.

## Where the step script comes from

The orb's `run` command fetches the step script from
`https://raw.githubusercontent.com/ZanattaMichael/Dsc.PipelineRunnerActions/<actions-ref>/core/`.
Both tiers pass `actions-ref` as the commit under test, so what they test is `core/` as it is at
that commit on GitHub: in CI the pushed commit, and by hand whatever `--actions-ref` names (by
default `HEAD`, which must have been pushed). A pull request from a fork cannot be tested this
way, so CI skips both jobs for one.

## Contract tier

CircleCI processes a configuration on its servers: it resolves an orb command's parameters,
substitutes `<< parameters.x >>` into its steps and evaluates `when` and `unless`; the build
agent then runs the steps. `orb.js` does the processing (parameter defaults, types, enums,
substitution, logic statements, the orb validator's checks) and `agent.js` the agent's part
(`/bin/bash -eo pipefail` by default, the job's environment and the step's own on top, steps
after a failure run only with `when: always`, what `store_artifacts` would upload, masking of
context values).

```bash
npm ci
```

```bash
node tests/integration/circleci/run-cases.js --actions-ref <commit on GitHub>
```

Add `--case <text>` to run the cases whose folder name contains the text, and `--shell pwsh` to
run the commands in PowerShell (the default on Windows, as on a Windows executor). A failing case
prints the job log. `orb.test.js` tests the stand-ins themselves.

## Live tier

`live/run-local-execute.js` needs Docker and the [CircleCI CLI](https://circleci.com/docs/local-cli/).
It writes one configuration with the orb inlined and one job per accepted case, has CircleCI
validate it, then runs each job with `circleci local execute`: the real agent, in the orb's
default executor image, with the case's secrets passed as `--env`. A verify step with
`when: always` prints `outputs.env`, the recorded call and whether the report directory exists.
Cases CircleCI must refuse are validated one by one and must be rejected.

```bash
node tests/integration/circleci/live/run-local-execute.js --actions-ref <commit on GitHub>
```

`--print-config` prints the generated configuration without running anything. If the CLI needs a
token to process the configuration, set `CIRCLE_TOKEN` (a personal API token); the script exits 3
when it would need one and none is set, and the CI job then reports that instead of failing.

What local execute cannot show: `store_artifacts` (uploads are skipped), contexts, and
workflows. Those are covered by the contract tier (artifacts) or not at all (a real CircleCI
project would be needed).

The first version of this tier was written without the CLI to run it against; the generator and
the result reader are unit-tested (`live/config.test.js`), and CI is its proof.

## Adding a case

Add a folder under `cases/` with a `case.json`; the fields are described at the top of
`run-cases.js`. Both tiers pick it up. A case CircleCI refuses when it processes the
configuration sets `expect.parameterProblems` (patterns for the stand-in's messages) and
`expect.liveParameterProblems` (patterns for CircleCI's own). Set `"live": false` for a case that
only makes sense against the stand-ins.
