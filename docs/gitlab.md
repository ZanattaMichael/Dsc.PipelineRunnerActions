# <img src="../assets/logo-gitlab.svg" alt="" width="48" align="top"> GitLab CI/CD

The integration is a CI/CD component, `dsc-pipeline-runner`, that adds one job to your pipeline.

## Requirements

- GitLab 17.0 or later (components and the CI/CD Catalog are generally available from 17.0).
- The component published in a GitLab project you can reach; see [publishing.md](publishing.md).
  Replace `<group>` below with where it lives on your instance.
- A runner whose job image has PowerShell 7. The default image is
  `mcr.microsoft.com/dotnet/sdk:8.0`. For the DscV2 engine use a Windows runner with PowerShell 7
  (`runner_tags`); for DscV3 use an image that also contains `dsc`.
- Outbound HTTPS from the job to `raw.githubusercontent.com` (the job fetches the step script) and
  to the PowerShell Gallery unless `skip_module_install` is `true`.
- Everything in [requirements.md](requirements.md) that applies to your engine and mode.

## Use

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/dsc-pipelinerunner-actions/dsc-pipeline-runner@1
    inputs:
      stage: test
      configuration_path: config
      mode: Test
      module_version: 1.2.1
      resource_modules: PSDscResources@2.12.0.0
```

Inputs are the snake_case form of the settings in [settings.md](settings.md), plus:

| Input | Default | Purpose |
| --- | --- | --- |
| `job_name` | `dsc-pipeline-runner` | Name of the job. Change it to include the component more than once. |
| `stage` | `test` | Stage of the job. |
| `image` | `mcr.microsoft.com/dotnet/sdk:8.0` | Job image. |
| `runner_tags` | `[]` | Runner tags. |
| `actions_ref` | `v1` | Tag or commit of this repository that the step script is fetched from. Pin a full commit SHA to make it immutable. |

Add `rules`, `environment`, `needs` and so on by declaring a job with the same name; GitLab merges
it with the component's job:

```yaml
dsc-pipeline-runner:
  environment: production
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

## Secrets

Secrets are not inputs. Define masked (and, for protected branches, protected) CI/CD variables in
Settings > CI/CD > Variables:

| Variable | Purpose |
| --- | --- |
| `DSCPR_SOURCE_TOKEN` | Token to clone `configuration_repository_url`. |
| `DSCPR_AZURE_DEVOPS_TOKEN` | Azure DevOps personal access token. |

## Outputs and reports

The report directory is stored as a job artifact, also when the job fails. The outputs are a
dotenv report, so later jobs receive `DSCPR_STATUS`, `DSCPR_FAIL_COUNT` and the rest as variables.

## Version to reference

`@1` (newest 1.x), `@1.2.0` (one release) or `@<commit SHA>`.
