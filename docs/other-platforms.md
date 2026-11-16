# Other platforms

Bitbucket Pipelines, TeamCity, Bamboo, Buildkite, Drone, a scheduled task: anything that can run
PowerShell 7 can run the step script directly. The packaged integrations do nothing more than this.

## The contract

1. Get this repository at a release you have reviewed (a tag, or better a full commit SHA).
2. Set the settings as `DSCPR_*` environment variables ([settings.md](settings.md) lists them).
   Put secrets in the platform's secret store so they arrive as `DSCPR_SOURCE_TOKEN` /
   `DSCPR_AZURE_DEVOPS_TOKEN`.
3. Run `pwsh -NoLogo -NoProfile -NonInteractive -File core/Invoke-DscPipelineRunnerStep.ps1`.
4. Use the exit code (`0` success, `1` failed, `2` invalid settings) and, if you need them, the
   outputs in `<report-path>/outputs.env` and `<report-path>/result.json`.

```sh
git clone https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions .dscpr
git -C .dscpr checkout --detach <full commit SHA>

export DSCPR_CONFIGURATION_PATH=config
export DSCPR_MODE=Test
export DSCPR_MODULE_VERSION=1.2.1
pwsh -NoLogo -NoProfile -NonInteractive -File .dscpr/core/Invoke-DscPipelineRunnerStep.ps1
```

Set `DSCPR_PLATFORM=generic` if the platform is mistaken for another one (the script detects
GitHub, Azure DevOps, GitLab, CircleCI and Jenkins from their environment variables; this only
affects how log groups, annotations and outputs are written).

## Bitbucket Pipelines

[`examples/other/bitbucket-pipelines.yml`](../examples/other/bitbucket-pipelines.yml). Bitbucket
steps run in Linux containers, so use the DscV3 engine with an image that contains `dsc`, or
configurations whose resources target remote machines. A packaged Bitbucket Pipe is not provided:
a pipe is a Docker image of its own, and the step needs your engine and resource modules in that
image, so your own image plus the three lines above is the better fit.

## Requirements

The same as everywhere else: [requirements.md](requirements.md).
