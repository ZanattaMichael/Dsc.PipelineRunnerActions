# <img src="../assets/logo-circleci.svg" alt="" width="48" align="top"> CircleCI

The integration is an orb, `<namespace>/dsc-pipeline-runner`, with a `run` job (check out and run), an `execute`
command (run inside your own job) and a `default` executor. The command is not called `run`
because that is CircleCI's built-in step.

## Requirements

- The orb published in a namespace you can use; see [publishing.md](publishing.md). An orb from a
  namespace that is not certified needs "Allow uncertified orbs" in the organization's security
  settings.
- An executor with PowerShell 7. The `default` executor uses `mcr.microsoft.com/dotnet/sdk:8.0`.
  For the DscV2 engine use a Windows executor with PowerShell 7; for DscV3 pass an image that also
  contains `dsc`.
- Outbound HTTPS to `raw.githubusercontent.com` (the step script is fetched at the commit the orb
  version was released from) and to the PowerShell Gallery unless `skip-module-install` is `true`.
- Everything in [requirements.md](requirements.md) that applies to your engine and mode.

## Use

```yaml
version: 2.1

orbs:
  dsc: <namespace>/dsc-pipeline-runner@1

workflows:
  compliance:
    jobs:
      - dsc/run:
          configuration-path: config
          engine: DscV3
          mode: Test
          module-version: 1.2.1
          executor:
            name: dsc/default
            image: registry.example.com/dsc-agent:1
```

Or the command inside your own job:

```yaml
jobs:
  apply:
    executor: dsc/default
    steps:
      - checkout
      - dsc/execute:
          configuration-path: config
          mode: Set
```

Parameters have the same names as the settings in [settings.md](settings.md). Booleans are real
booleans (`fail-on-error: false`).

## Secrets

Secrets are read from environment variables; keep them in a context. By default the orb reads
`DSCPR_SOURCE_TOKEN` and `DSCPR_AZURE_DEVOPS_TOKEN`. To use other names:

```yaml
      - dsc/run:
          context: dsc-production
          source-token-variable: CONFIG_REPO_TOKEN
```

## Outputs and reports

The report directory is stored as a job artifact under `dsc-reports`. Outputs are in
`<report-path>/outputs.env` and `<report-path>/result.json` for later steps.
