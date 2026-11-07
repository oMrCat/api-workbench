// IPC 通道名单（纯常量，无依赖）。
// preload 处于 sandbox 模式，只能 require('electron')——因此通道名必须与 zod Schema 分离。

export const IPC = {
  AppInfo: 'app:get-info',
  ProvidersList: 'providers:list',
  ProvidersSave: 'providers:save',
  ProvidersDelete: 'providers:delete',
  ProvidersExport: 'providers:export',
  ProvidersImport: 'providers:import',
  SecretsStatus: 'secrets:status',
  SecretSet: 'secrets:set',
  SecretGetPreview: 'secrets:get-preview',
  SecretDelete: 'secrets:delete',
  ModelsSync: 'models:sync',
  ModelsGet: 'models:get',
  ModelsSaveEntry: 'models:save-entry',
  ModelsDeleteEntry: 'models:delete-entry',
  TestRun: 'test:run',
  TestCancel: 'test:cancel',
  RunEvent: 'test:event', // main -> renderer 推送
  HistoryList: 'history:list',
  HistoryDelete: 'history:delete',
  HistoryClear: 'history:clear',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  ExportReport: 'export:report',
  CurlSample: 'report:curl',
  OpenExternal: 'window:open-external',
  MockStart: 'mock:start',
  MockStop: 'mock:stop',
  MockStatus: 'mock:status'
} as const
