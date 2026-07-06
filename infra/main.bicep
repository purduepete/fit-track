// fittrack infrastructure — Azure Container Apps (Consumption, scale-to-zero).
// Provisions a dedicated ACR and a user-assigned managed identity; the Azure SQL
// server AND the Log Analytics workspace are reused cross-RG from the existing
// webportfolio deployment (tables live in the `fit` schema of the WebPortfolio
// database), so neither a database nor a workspace resource is created here.
//
//   az group create -n fittrack-rg -l eastus2
//   az acr build -r <acrName> -t fittrack:v1 -t fittrack:latest .
//   az deployment group create -g fittrack-rg -f infra/main.bicep \
//        -p acrName=<acrName> containerImage=<acrName>.azurecr.io/fittrack:v1
//
// The app authenticates to Azure SQL with its USER-ASSIGNED managed identity
// (DB_AUTH=aad; AZURE_CLIENT_ID selects it) and pulls its image from the ACR with
// the same identity. After the first deploy, grant the identity
// ([fittrack-identity]) access to the fit schema (see docs/architecture.md).

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Container image, e.g. <acrName>.azurecr.io/fittrack:v1.')
param containerImage string

@description('Name of the Azure Container Registry the image is pulled from (created here).')
param acrName string

@description('Azure SQL server FQDN (existing webportfolio server).')
param dbServer string = 'sqlgkhw25ijhyzzy.database.windows.net'

@description('Database name.')
param dbName string = 'WebPortfolio'

@description('Existing Log Analytics workspace to reuse (avoids a dedicated workspace + its cost).')
param logWorkspaceName string = 'loggkhw25ijhyzzy'

@description('Resource group of the existing Log Analytics workspace.')
param logWorkspaceResourceGroup string = 'investmentportfolio'

@description('Athlete birth date (YYYY-MM-DD) for VO2 max interpretation. Empty disables it.')
param athleteBirthDate string = ''

@description('Athlete sex (male|female) for VO2 max interpretation. Empty disables it.')
param athleteSex string = ''

var namePrefix = 'fittrack'

// Dedicated registry for the app image; pulled via the user-assigned identity
// below (no admin user / registry passwords).
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// One identity used for BOTH ACR pull and Azure SQL (DB_AUTH=aad). Using a
// user-assigned identity (rather than system-assigned) lets the AcrPull role be
// granted before the app exists, avoiding a first-pull race.
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-identity'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, uami.id, 'AcrPull')
  scope: acr
  properties: {
    // AcrPull built-in role.
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
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
  dependsOn: [
    acrPull
  ]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: uami.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: containerImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
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
        }
      ]
      scale: {
        // Scale to zero when idle to minimise cost for a personal tracker.
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'http'
            // Bound concurrency: each request buffers the full body (up to
            // max_ingest_bytes) so keep this low on a small-memory replica.
            http: { metadata: { concurrentRequests: '5' } }
          }
        ]
      }
    }
  }
}

output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Registry the image is pulled from.')
output acrLoginServer string = acr.properties.loginServer

@description('Name of the app user-assigned identity — used for the SQL CREATE USER ... FROM EXTERNAL PROVIDER grant.')
output identityName string = uami.name

@description('Client id of the app identity (matches the AZURE_CLIENT_ID env var).')
output identityClientId string = uami.properties.clientId

@description('Principal (object) id of the app identity.')
output identityPrincipalId string = uami.properties.principalId
