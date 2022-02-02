const path = require('path')
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
})

import { AppWebsocket } from '@holochain/conductor-api'

import Websocket from 'ws'

import { WsClient as HolochainWsClient } from '@holochain/conductor-api/lib/websocket/client'

import ReconnectingWebSocket from 'reconnecting-websocket'

export default class HcAppWebSocket extends AppWebsocket {
  constructor(url, signalCb, ...args) {
    super(
      new HolochainWsClient(
        new ReconnectingWebSocket(url, [], {
          WebSocket: Websocket,
          maxRetries: 300,
        }),
        signalCb,
      ),
      ...args,
    )
  }

  close(): Promise<void> {
    this.client.socket.close()
    return this.closed()
  }

  opened = () =>
    new Promise<void>((resolve, reject) => {
      this.client.socket.addEventListener('open', () => resolve())
      if (this.client.socket.readyState === Websocket.OPEN) {
        log.debug('HcAppWebSocket connection opened')
        resolve()
      }
    })

  closed = () =>
    new Promise<void>((resolve, reject) => {
      this.client.socket.addEventListener('close', () => resolve())
      if (
        this.client.socket.readyState === Websocket.CLOSED ||
        this.client.socket.readyState === Websocket.CONNECTING
      ) {
        log.debug('HcAppWebSocket connection closed')
        resolve()
      }
    })
}