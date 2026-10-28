/**
 * Smoke test for the host half: mount the plugin against a stub Context and drive
 * the routes that need no browser window. Run with:
 *   node test/smoke.mjs
 */

import { apply } from '../lib/index.js'

const routes = new Map()

const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  },
  get(name) {
    if (name === 'connection') {
      return {
        authenticatedUrl(baseUrl) {
          const url = new URL(baseUrl)
          url.searchParams.set('token', 'TESTTOKEN')
          return url.toString()
        },
      }
    }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
}

const plugin = await import('../lib/index.js')
console.log('exports:', Object.keys(plugin))
apply(ctx, { titlePrefix: 'DSH 小窗', width: 460, height: 920 })

console.log('routes:', [...routes.keys()].join(', '))

/** Minimal response double that records the JSON body. */
function callRoute(path) {
  return new Promise((resolve, reject) => {
    const handler = routes.get(path)
    if (handler === undefined) { reject(new Error(`missing route ${path}`)); return }
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
      end(body) {
        try { resolve({ status: this.statusCode, body: JSON.parse(body) }) } catch { resolve({ status: this.statusCode, body }) }
      },
    }
    const req = { method: 'GET', on() {}, setEncoding() {} }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const state = await callRoute('/dsh-hud/state')
console.log('state ->', JSON.stringify(state))

// /open must refuse a non-local URL before touching the browser.
const res = {
  statusCode: 0,
  headers: {},
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
  end(body) { console.log('open(non-local) ->', this.statusCode, body) },
}
const listeners = {}
const req = {
  method: 'POST',
  setEncoding() {},
  on(event, fn) { listeners[event] = fn },
  error() {},
}
const handler = routes.get('/dsh-hud/open')
Promise.resolve(handler(req, res)).then(() => {
  listeners.data(JSON.stringify({ href: 'https://example.com/' }))
  listeners.end()
})
