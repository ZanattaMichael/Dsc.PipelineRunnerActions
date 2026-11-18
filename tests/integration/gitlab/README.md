# GitLab integration tests

Two tiers run the same cases (`cases/*/case.json`) against the GitLab CI/CD component.

| Tier | What is real | What is a stand-in | Runs |
| --- | --- | --- | --- |
| **Server and runner contract** (`run-cases.js`) | The component template, PowerShell 7, the step script | GitLab's handling of a component (`component.js`), a shell runner (`runner.js`), Dsc.PipelineRunner (`tests/fixtures/modules`) | In CI on every push, on Linux (bash job shell) and Windows (PowerShell job shell) |
| **Live** (`live/run-live.js`) | GitLab CE and GitLab Runner in Docker: the spec and input checks, include merging, variable expansion, masked variables, the raw file endpoint the step script is fetched from, artifacts and the dotenv report; the job image with PowerShell 7 | Dsc.PipelineRunner | In CI on every push (about 15 minutes, most of it starting GitLab) |

The stand-in module records the arguments it was called with inside the report directory, so a
case can check what reached it, and no DSC resources are needed.

## Contract tier

GitLab resolves a component's inputs, interpolates them into the template and merges the result
with the pipeline's own jobs on the server; a runner then executes the job's script. Neither can
be used without a GitLab server, so `component.js` does the server's part (spec checks, input
defaults, options and types, `$[[ inputs.x ]]` interpolation including array inputs, the merge of
a local job over the included one, the pipeline editor's checks, `$VARIABLE` expansion, the
dotenv report rules) and `runner.js` does the runner's (predefined `CI_*` variables, one shell
session that stops at the first failing line, artifact collection with `artifacts:when`, masking).

The component fetches the step script from `DSCPR_CORE_URL`, which the template builds from
`actions_ref`. The cases override that variable on the job, the way any pipeline can override a
component's variable, so it points at a local web server serving this working tree's `core/`.

```bash
npm ci
```

```bash
node tests/integration/gitlab/run-cases.js
```

Add `--case <text>` to run the cases whose folder name contains the text, and `--shell pwsh` to
use the PowerShell job shell (the default on Windows). A failing case prints the job log.
`component.test.js` tests the stand-ins themselves.

## Live tier

`live/run-live.js` needs Docker and nothing else. It starts GitLab CE and a GitLab Runner (Docker
executor) on a private network, creates an access token, pushes this working tree to a public
project with a generated `.gitlab-ci.yml`, and lets the push create the pipeline. Each accepted
case is one job that includes the component from that project at the commit under test
(`include: component: $CI_SERVER_FQDN/root/<project>/dsc-pipeline-runner@$CI_COMMIT_SHA`, the
same form `.gitlab-ci.yml` at the root uses), with `DSCPR_CORE_URL` pointing at the server's raw
file endpoint for that commit. A verify job after each case prints the dotenv variables, the
recorded call and the artifacts. Cases GitLab must refuse are checked one by one through the CI
lint API. Everything is removed afterwards; `--keep` leaves the containers running and prints
the root password.

```bash
node tests/integration/gitlab/live/run-live.js
```

`--print-yaml` prints the generated pipeline without starting anything. `DSCPR_GITLAB_IMAGE`,
`DSCPR_GITLAB_RUNNER_IMAGE` and `DSCPR_GITLAB_PORT` change the images and the host port.

The first version of this tier was written without a GitLab server to run it against; the
generator and the result reader are unit-tested (`live/pipeline.test.js`), and CI is its proof.

## Adding a case

Add a folder under `cases/` with a `case.json`; the fields are described at the top of
`run-cases.js`. Both tiers pick it up. A case GitLab refuses at pipeline creation sets
`expect.inputProblems` (patterns for the stand-in's messages) and `expect.liveInputProblems`
(patterns for GitLab's own). Set `"live": false` for a case that only makes sense against the
stand-ins. Masked variables are project variables in the live tier, so two cases may not give one
name different values.
