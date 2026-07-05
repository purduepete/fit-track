// fittrack infrastructure — Azure Container Apps (Consumption, scale-to-zero).
// Deployed into a NEW dedicated resource group; the Azure SQL server AND the
// Log Analytics workspace are reused cross-RG from the existing webportfolio
// deployment (tables live in the `fit` schema of the WebPortfolio database),
// so neither a database nor a workspace resource is created here.
//
//   az group create -n fittrack-rg -l westus2
//   az deployment group create -g fittrack-rg -f infra/main.bicep \
//        -p containerImage=ghcr.io/purduepete/fittrack:latest
//
// The app authenticates to Azure SQL with its SYSTEM-ASSIGNED managed identity
// (DB_AUTH=aad) — no password is provisioned. After the first deploy, grant the
// identity ([fittrack-api]) access to the fit schema (see docs/architecture.md).

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Container image (e.g. ghcr.io/<owner>/fittrack:latest).')
param containerImage string

@description('Azure SQL server FQDN (existing webportfolio server).')
param dbServer string = 'sqlgkhw25ijhyzzy.database.windows.net'

@description('Database name.')
param dbName string = 'WebPortfolio'

@description('Existing Log Analytics workspace to reuse (avoids a dedicated workspace + its cost).')
param logWorkspaceName string = 'loggkhw25ijhyzzy'

@description('Resource group of the existing Log Analytics workspace.')
param logWorkspaceResourceGroup string = 'investmentportfolio'

var namePrefix = 'fittrack'

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
    // System-assigned identity used to authenticate to Azure SQL (DB_AUTH=aad).
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
      }
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
            { name: 'DB_SERVER', value: dbServer }
            { name: 'DB_NAME', value: dbName }
            { name: 'DB_SCHEMA', value: 'fit' }
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
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Principal (object) id of the app managed identity — grant it access to the fit schema.')
output identityPrincipalId string = app.identity.principalId
