import { HostedAppConfig } from './hosted-app-config-interface'

export interface EnvoyConfig {
  mode: number
  port?: number
  NS?: string
  hosted_app?: HostedAppConfig
}
