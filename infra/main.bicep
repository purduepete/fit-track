// fittrack infrastructure — Azure Container Apps (Consumption, scale-to-zero).
// Provisions a user-assigned managed identity; the container image is pulled from
// GitHub Container Registry (ghcr.io) — NOT a dedicated Azure Container Registry —
// to avoid the ACR Basic daily fee (ghcr private packages are free within the
// GitHub free tier). The Azure SQL server AND the Log Analytics workspace are
// reused cross-RG from the existing webportfolio deployment (tables live in the
// `fit` schema of the WebPortfolio database), so neither a database nor a
// workspace resource is created here.
//
//   az group create -n fittrack-rg -l eastus2
//   # build + push the image to ghcr.io (see .github/workflows/deploy.yml)
//   az deployment group create -g fittrack-rg -f infra/main.bicep \
//        -p containerImage=ghcr.io/<owner>/fittrack:v1 \
//           registryUsername=<owner> registryPassword=<ghcr-PAT>
//
// The app authenticates to Azure SQL with its USER-ASSIGNED managed identity
// (DB_AUTH=aad; AZURE_CLIENT_ID selects it). The ghcr.io image is a PRIVATE
// package, so the app pulls it using a PAT (read:packages) stored as a Container
// App secret. After the first deploy, grant the identity ([fittrack-identity])
// access to the fit schema (see docs/architecture.md).

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Container image, e.g. ghcr.io/<owner>/fittrack:v1.')
param containerImage string

@description('Container registry login server (ghcr.io for GitHub Container Registry).')
param registryServer string = 'ghcr.io'

@description('Container registry username (GitHub username/owner for ghcr.io).')
param registryUsername string

@description('Registry PAT with read:packages scope. Stored as a Container App secret and used to pull the private image.')
@secure()
param registryPassword string

@description('Azure SQL server FQDN (existing webportfolio server).')
param dbServer string = 'sqlgkhw25ijhyzzy.database.windows.net'

@description('Database name.')
param dbName string = 'WebPortfolio'

@description('Existing Log Analytics workspace to reuse (avoids a dedicated workspace + its cost).')
param logWorkspaceName string = 'loggkhw25ijhyzzy'

@description('Resource group of the existing Log Analytics workspace.')
param logWorkspaceResourceGroup string = 'investmentportfolio'

@description('Athlete birth date (YYYY-MM-DD) for VO2 max interpretation. Empty disables it.')
param athleteBirthDate string = '1970-09-20'

@description('Athlete sex (male|female) for VO2 max interpretation. Empty disables it.')
param athleteSex string = 'male'

var namePrefix = 'fittrack'

// One identity used for Azure SQL auth (DB_AUTH=aad). Using a user-assigned
// identity (rather than system-assigned) keeps the same client id stable across
// deployments for the SQL CREATE USER ... FROM EXTERNAL PROVIDER grant.
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-identity'
  location: location
}

// Reuse the existing (webportfolio) workspace cross-RG rather than creating a
// dedicated one — for a personal tracker this just routes container logs and
// removes a separate Log Analytics billing line.
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logWorkspaceName
  scope: resourceGroup(logWorkspaceResourceGroup)
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  dependsOn: []
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
      }
      secrets: [
        {
          // PAT (read:packages) used to pull the private ghcr.io image.
          name: 'registry-password'
          value: registryPassword
        }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'DB_AUTH', value: 'aad' }
            // Select the user-assigned identity for DefaultAzureCredential.
            { name: 'AZURE_CLIENT_ID', value: uami.properties.clientId }
            { name: 'DB_SERVER', value: dbServer }
            { name: 'DB_NAME', value: dbName }
            { name: 'DB_SCHEMA', value: 'fit' }
            { name: 'ATHLETE_BIRTH_DATE', value: athleteBirthDate }
            { name: 'ATHLETE_SEX', value: athleteSex }
          ]
          // Probes against the unauthenticated /api/health route. The startup
          // probe gives boot (incl. DB pre-warm + AAD token) up to ~60s; the
          // readiness probe holds traffic until the app is actually ready so
          // the first request never lands on a half-started replica.
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/api/health', port: 8000 }
              initialDelaySeconds: 1
              periodSeconds: 2
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 8000 }
              initialDelaySeconds: 2
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 8000 }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        // Scale to zero when idle to minimise cost; two narrow KEDA cron rules
        // keep one warm replica only during the hours the app is actually used
        // (07:00-09:00 and 17:00-21:00 local, 6h/day) to avoid cold-start
        // latency then, while dropping to zero the rest of the day/night. A
        // 24/7-ish warm window burns the monthly free vCPU-second grant in ~12
        // days and then costs ~$0.17/day, mostly idle usage — hence the tight
        // windows below.
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'http'
          // Bound concurrency: a large ingest buffers the full body (up to
          // max_ingest_bytes, ~64 MiB) and deserializes it, which is memory
          // heavy, so keep this modest even on the 1 GiB replica. Also handles
          // request-based wake-from-zero outside warm hours.
            http: { metadata: { concurrentRequests: '5' } }
          }
          {
            name: 'warm-morning'
            // Keep 1 replica warm 07:00-09:00 America/Los_Angeles.
            custom: {
              type: 'cron'
              metadata: {
                timezone: 'America/Los_Angeles'
                start: '0 7 * * *'
                end: '0 9 * * *'
                desiredReplicas: '1'
              }
            }
          }
          {
            name: 'warm-evening'
            // Keep 1 replica warm 17:00-21:00 America/Los_Angeles.
            custom: {
              type: 'cron'
              metadata: {
                timezone: 'America/Los_Angeles'
                start: '0 17 * * *'
                end: '0 21 * * *'
                desiredReplicas: '1'
              }
            }
          }
        ]
      }
    }
  }
}

output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Name of the app user-assigned identity — used for the SQL CREATE USER ... FROM EXTERNAL PROVIDER grant.')
output identityName string = uami.name

@description('Client id of the app identity (matches the AZURE_CLIENT_ID env var).')
output identityClientId string = uami.properties.clientId

@description('Principal (object) id of the app identity.')
output identityPrincipalId string = uami.properties.principalId
