# Jenkins

The integration is a Pipeline shared-library step, `dscPipelineRunner`. Jenkins loads shared
libraries straight from Git, so there is no registry: you register this repository once.

## Requirements

- Jenkins with the Pipeline suite (`workflow-aggregator`), which includes **Pipeline: Groovy
  Libraries**, and the **Credentials Binding** plugin. The step uses only standard steps (`sh`,
  `bat`, `withEnv`, `withCredentials`, `readFile`, `writeFile`, `libraryResource`).
- An agent with PowerShell 7 on `PATH`. The step checks and says so if it is missing. Use a
  Windows agent for the DscV2 engine.
- Everything in [requirements.md](requirements.md) that applies to your engine and mode.

## Register the library (once)

Manage Jenkins > System > Global Trusted Pipeline Libraries (or a folder's Pipeline Libraries):

| Field | Value |
| --- | --- |
| Name | `dsc-pipeline-runner` |
| Default version | `v1` (or a release tag such as `v1.2.0`) |
| Retrieval method | Modern SCM > Git |
| Project repository | `https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions.git` |
| **Library Path** | `jenkins/` |

The Library Path matters: the library lives in the `jenkins/` folder of this repository.

## Use

```groovy
@Library('dsc-pipeline-runner@v1') _

pipeline {
    agent { label 'windows && pwsh' }
    stages {
        stage('Drift') {
            steps {
                script {
                    def result = dscPipelineRunner(
                        configurationPath: 'config',
                        mode: 'Test',
                        moduleVersion: '1.2.1',
                        resourceModules: 'PSDscResources@2.12.0.0'
                    )
                    echo "Status: ${result.status}"
                }
            }
        }
    }
    post { always { archiveArtifacts artifacts: 'dsc-reports/**', allowEmptyArchive: true } }
}
```

Arguments are the camelCase form of the settings in [settings.md](settings.md). An unknown
argument is an error that lists the known ones.

## Secrets

Create "Secret text" credentials and pass their IDs:

```groovy
dscPipelineRunner(
    configurationRepositoryUrl: 'https://git.example.com/platform/config.git',
    sourceTokenCredentialsId: 'config-repo-token',
    connect: 'AzureDevOps',
    azureDevopsOrganization: 'contoso',
    azureDevopsTokenCredentialsId: 'azure-devops-pat'
)
```

Passing a secret as a plain argument is rejected.

## Result

The step returns a map: `status`, `totalResources`, `passCount`, `failCount`, `skipCount`,
`reportPath`, `moduleVersion`. It fails the build when the run failed and `failOnError` is true
(the default). With `failOnError: false` inspect `result.status` yourself.
