# Azure DevOps integration tests

Two tiers run the same cases (`cases/*/case.json`) against the Azure DevOps task.

| Tier | What is real | What is a stand-in | Runs |
| --- | --- | --- | --- |
| **Agent contract** (`run-cases.js`) | The packaged extension (`.vsix`), the task's `task.json` and entry point, Node, PowerShell 7, the step script | The Azure Pipelines agent (`agent.js`) and Dsc.PipelineRunner (`tests/fixtures/modules`) | In CI on every push, on Linux and Windows, with Node 20 and Node 24 |
| **Live** (`live/run-live.js`) | All of the above, plus Azure DevOps itself: the task store, YAML parsing, a real agent, secret variables and log masking | Dsc.PipelineRunner | In CI only where an organization is configured; otherwise skipped |

The stand-in module records the arguments it was called with, so a case can check what reached
it and no DSC resources are needed.

## Agent contract tier

A real agent has to register with an Azure DevOps organization, so CI cannot start one.
`agent.js` does what the agent does for a Node task: it finds the task in the extension
manifest, resolves the step's inputs (defaults, then the step's values, then `$(variable)`
macros), passes inputs as `INPUT_<NAME>` and non-secret variables as environment variables, runs
the execution target, and reads the `##vso[...]` logging commands back into a step result, output
variables and issues. It also checks the packaged task for what the service refuses at install
time (id, name, version, handler targets, input declarations).

```bash
./tools/Sync-Core.ps1 -AzureDevOps
```

```bash
npx --yes tfx-cli@0 extension create --root azure-devops --manifest-globs vss-extension.json --output-path dist
```

```bash
node tests/integration/azure-devops/run-cases.js --vsix dist/<file>.vsix
```

Add `--case <text>` to run the cases whose folder name contains the text. A failing case prints
the step log. `agent.test.js` tests the stand-in itself.

What this tier cannot show: that Azure DevOps accepts the upload, how the service parses the
pipeline YAML, and the service's own log masking. The live tier covers those.

## Live tier

`live/run-live.js` uploads the task from the working tree to the organization under a test name
(`DscPipelineRunnerIntegrationTest`) and its own id, so it cannot be confused with the published
extension. It then creates a repository with a generated `azure-pipelines.yml` and the fixtures,
creates a pipeline with the cases' secret variables, runs it, and reads the timeline and logs to
check every case. The pipeline, the repository and the task are removed afterwards, whatever
happened (`--keep` leaves them).

> **Status:** the live tier has not yet been run against an organization. The pipeline generator
> and the result reader are unit-tested (`live/pipeline.test.js`); the calls to Azure DevOps are
> not. Expect the first configured run to need fixes.

### What it needs

| Setting | Where | Value |
| --- | --- | --- |
| `AZURE_DEVOPS_TEST_ORG` | Repository variable | The organization: its name, or `https://dev.azure.com/<name>` |
| `AZURE_DEVOPS_TEST_PROJECT` | Repository variable | A project in it. Use one kept for testing. |
| `AZURE_DEVOPS_TEST_TOKEN` | Repository secret | A personal access token (scopes below) |
| `AZURE_DEVOPS_TEST_POOL` | Repository variable, optional | An agent pool to run on. Without it, a Microsoft-hosted agent is used. |
| `AZURE_DEVOPS_TEST_VM_IMAGE` | Repository variable, optional | The Microsoft-hosted image. Default `ubuntu-latest`. |

The CI job `Azure DevOps live` runs when `AZURE_DEVOPS_TEST_ORG` is set, and never for a pull
request from a fork.

The token needs to create and delete a repository, create, run and delete a pipeline, and upload
and delete a task:

- **Code**: read, write and manage
- **Build**: read and execute
- **Agent Pools**: read and manage
- Uploading a task is an organization-level action; the token's owner must be allowed to
  manage tasks (a member of *Project Collection Administrators* is). If the upload is refused
  with the scopes above, a full-access token is needed.

The agent that runs the pipeline needs PowerShell 7 and Node. Microsoft-hosted agents have both.
A new organization has no Microsoft-hosted parallel jobs until Microsoft grants its free tier;
without it the run fails at once and the test prints what the run reported. A self-hosted pool
(`AZURE_DEVOPS_TEST_POOL`) avoids that, and must be open to new pipelines ("Grant access
permission to all pipelines"), or the run waits for a person to permit it.

### Running it by hand

```bash
export DSCPR_AZDO_ORG=<organization>
```

```bash
export DSCPR_AZDO_PROJECT=<project>
```

```bash
read -rs DSCPR_AZDO_TOKEN && export DSCPR_AZDO_TOKEN
```

```bash
node tests/integration/azure-devops/live/run-live.js
```

`--print-yaml` prints the pipeline it would run, without contacting Azure DevOps.

## Adding a case

Add a folder under `cases/` with a `case.json`; the fields are described at the top of
`run-cases.js`. Both tiers pick it up. Set `"live": false` for a case that only makes sense
against the stand-in agent. Two cases may not give the same pipeline variable different values,
because the live tier runs all cases in one pipeline.
