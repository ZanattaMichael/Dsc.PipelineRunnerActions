# <img src="../assets/logo-github-actions.svg" alt="" width="48" align="top"> GitHub Actions

## Requirements

- A runner with PowerShell 7. GitHub-hosted runners have it. Use `windows-latest` for the DscV2
  engine with Windows-only resources.
- `actions/checkout` before the step when you use `configuration-path`.
- Everything in [requirements.md](requirements.md) that applies to your engine and mode.

## Use

```yaml
jobs:
  drift:
    runs-on: windows-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - id: dsc
        uses: ZanattaMichael/Dsc.PipelineRunnerActions@v1
        with:
          configuration-path: config
          mode: Test
          module-version: 1.2.1
          resource-modules: |
            PSDscResources@2.12.0.0
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dsc-reports
          path: ${{ steps.dsc.outputs.report-path }}
```

All inputs are optional strings with the defaults in [settings.md](settings.md). Booleans are
written as `'true'` / `'false'`.

## Secrets

```yaml
        with:
          configuration-repository-url: https://github.com/contoso/config.git
          source-token: ${{ secrets.CONFIG_REPO_TOKEN }}
```

The workflow's own `GITHUB_TOKEN` can only read the repository the workflow runs in. For another
private repository use a fine-grained personal access token or a GitHub App token with read access
to that repository.

## Outputs and the job summary

`status`, `total-resources`, `pass-count`, `fail-count`, `skip-count`, `report-path`,
`module-version`: `${{ steps.dsc.outputs.status }}`. The step also adds a one-table result to the
job summary. For a per-resource summary, enable Dsc.PipelineRunner's own `Summary` reporter in the
configuration.

## Version to reference

| Reference | Meaning |
| --- | --- |
| `@v1` | The newest 1.x release. Moves with each release. |
| `@v1.2.0` | One release. |
| `@<full commit SHA>` | Immutable; what GitHub recommends for third-party actions. |

## Gate a `Set`

Put the job in an [environment](https://docs.github.com/actions/deployment/targeting-different-environments)
with required reviewers. See [`examples/github-actions`](../examples/github-actions).
