import { AppDna } from "./app-dna.interface";

export interface HostedAppConfig {
  servicelogger_id: string
  dnas: [AppDna]
  usingURL: boolean
}
