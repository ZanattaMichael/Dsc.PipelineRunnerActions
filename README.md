# Dsc.PipelineRunner Actions

CI/CD integrations for [Dsc.PipelineRunner](https://github.com/ZanattaMichael/Dsc.PipelineRunner):
run a Datum-driven Desired State Configuration as one step of a pipeline, with reports and a
pass/fail gate.

| Platform | Integration | Published to | Guide |
| --- | --- | --- | --- |
| GitHub Actions | Action ([`action.yml`](action.yml)) | GitHub Marketplace | [docs/github-actions.md](docs/github-actions.md) |
| Azure DevOps | Pipeline task in an extension ([`azure-devops/`](azure-devops)) | Visual Studio Marketplace | [docs/azure-devops.md](docs/azure-devops.md) |
| GitLab CI/CD | CI/CD component ([`templates/`](templates)) | CI/CD Catalog | [docs/gitlab.md](docs/gitlab.md) |
| CircleCI | Orb ([`circleci/orb.yml`](circleci/orb.yml)) | Orb registry | [docs/circleci.md](docs/circleci.md) |
| Jenkins | Shared-library step ([`jenkins/`](jenkins)) | Loaded from this repository by tag | [docs/jenkins.md](docs/jenkins.md) |
| Bitbucket, TeamCity, anything else | The step script itself ([`core/`](core)) | This repository | [docs/other-platforms.md](docs/other-platforms.md) |

Every integration is a thin wrapper around the same script, so they all take the same settings,
apply the same defaults and behave the same way.

## Quick start (GitHub Actions)

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: ZanattaMichael/Dsc.PipelineRunnerActions@v1
    with:
      configuration-path: config     # the folder that contains Datum.yml
      mode: Test                     # Test reports drift, Set applies, DryRun validates
      module-version: 1.2.1          # pin the Dsc.PipelineRunner version
```

The other platforms look the same; each guide has a copy-and-paste example, and
[`examples/`](examples) has a complete pipeline for each.

## What you need

The step checks all of this at the start of every run and reports everything that is missing in
one pass, so you do not fix one problem only to meet the next.

| Requirement | When |
| --- | --- |
| PowerShell 7 (`pwsh`) on the agent | Always |
| Outbound HTTPS to the PowerShell Gallery (or an internal feed) | Unless `skip-module-install` is `true` |
| The configuration checked out, or `git` to clone it | Always (one or the other) |
| A Windows agent | DscV2 engine with Windows-only resources (most of them) |
| The `dsc` command-line engine on `PATH` | DscV3 engine |
| A token for the configuration repository | Private repository cloned by URL |
| An Azure DevOps organization and token, and `AzureDevOpsDscNative` | `connect: AzureDevOps` |
| Rights to change the target systems | `mode: Set` |

Details, including how to install each item: [docs/requirements.md](docs/requirements.md).

## Settings

There are 20 settings in five groups. The most used:

| Setting | Default | Purpose |
| --- | --- | --- |
| `configuration-path` | (empty) | Folder in the workspace that contains `Datum.yml`. |
| `configuration-repository-url` | (empty) | Or: a Git repository to clone, with `configuration-revision` and `source-token`. |
| `mode` | `Test` | `Test`, `Set` or `DryRun`. |
| `engine` | `DscV2` | `DscV2` or `DscV3`. |
| `fail-on-error` | `true` | Fail the step when the run failed. In `Test` mode drift is a failure. |
| `report-path` | `dsc-reports` | Where the reports are written. |
| `module-version` | (empty) | Exact Dsc.PipelineRunner version. Pin it. |
| `resource-modules` | (empty) | DSC resource modules to install, as `Name@Version`. |

The full reference, with the name of each setting on each platform and the outputs:
[docs/settings.md](docs/settings.md).

At the start of each run the step prints the requirements it checked and the effective value of
every setting (secrets only as set or not set), so the log always shows what the run was given.

## Documentation

- [Requirements](docs/requirements.md)
- [Settings and outputs](docs/settings.md)
- Platform guides: [GitHub Actions](docs/github-actions.md), [Azure DevOps](docs/azure-devops.md),
  [GitLab](docs/gitlab.md), [CircleCI](docs/circleci.md), [Jenkins](docs/jenkins.md),
  [other platforms](docs/other-platforms.md)
- [Security](docs/security.md): how secrets and inputs are handled, and what to pin
- [Publishing](docs/publishing.md): the release pipeline and the one-time setup for each registry
- [Contributing](docs/contributing.md): repository layout, tests, adding a setting

## License

[MIT](LICENSE)
