# Writing a Vitrine plugin

Create a folder here with a `plugin.json` and, optionally, an `index.js`, then restart the studio.
Plugins run with the same access as the server, so only install code you trust.

```json
{
  "id": "hello", "name": "Hello", "version": "1.0.0", "description": "Shown on the Plugins page.",
  "contentTypes": [
    { "type": "hello", "label": "Hello", "fields": [
      { "key": "who", "label": "Who", "type": "text", "default": "world" }
    ] }
  ]
}
```

Field types: `text`, `url`, `number`, `color`, `checkbox`, `textarea`, `datetime-local`, `select` (with `options`).
The studio builds the editing form from these.

```js
// Returns the page shown on screen, in a sandboxed iframe. Escape anything from `config`.
export function render(type, config, { safeFetch }) {
  return `<!doctype html><h1>Hello</h1>`;
}

// Optional. Runs once at startup while the plugin is enabled.
export function setup({ router, on, db, log }) {
  router.get('/ping', (_req, res) => res.json({ pong: true })); // served at /plugins/hello/ping
  on('screen.offline', (screen) => log('offline:', screen.name)); // same event names as webhooks
}
```

`safeFetch(url)` fetches a URL as text and refuses private-network addresses. Use it for any URL an editor typed in.
