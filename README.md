# Browser Gate

A local-only Chrome extension that lets scripts inspect tabs, fetch session credentials, and run TypeScript automations on matching URLs.

The extension connects to a Bun WebSocket bridge on `127.0.0.1:17373`. There is no auth because the server only listens on localhost.

## Setup

```sh
bun install
bun run install-extension
```

On macOS the installer also registers the local bridge as a per-user LaunchAgent, so it is available after login without a terminal process. If Chrome is already open, the installer opens `chrome://extensions`. Enable Developer mode, click **Load unpacked**, and choose this repository's `dist` directory.

For development, leave this running:

```sh
bun run dev
```

It rebuilds changed TypeScript and reloads the connected extension. The CLI starts the local bridge automatically when needed.

## Tabs

```sh
scripts/invoke tabs list
scripts/invoke tabs list --group domain --sort title
scripts/invoke tabs list -g none -s url
```

Tabs have stable numbers based on their Chrome window and tab position. `--group` accepts `window`, `domain`, or `none`; `--sort` accepts `position`, `title`, `url`, or `domain`.

## Sessions

```sh
scripts/invoke get-session 4
scripts/invoke get-session https://subscription.cookunity.com/home
scripts/invoke get-session 4 --json
```

The plain command writes only the credential, so it can be piped to another script. `--json` also shows the tab, strategy, credential type, and source.

CookUnity has a dedicated strategy in `src/session-strategies.ts`. It briefly attaches Chrome's network debugger, reloads the selected CookUnity tab, captures the bearer token from its outgoing API request, and immediately detaches. Chrome may show its standard debugging banner during those few seconds. Other sites use the same Authorization-header capture, then storage and cookie fallbacks. Add domain-specific behavior to the same file when a site needs it.

## Automations

Automations live in `src/automations.ts` and are compiled into the extension. They run once whenever a matching URL finishes loading or changes through client-side navigation.

```ts
export const automations: BrowserAutomation[] = [
  {
    id: 'dismiss-example-banner',
    matches: ['*://*.example.com/*'],
    run: () => document.querySelector<HTMLElement>('.banner')?.click(),
  },
];
```

The function must be self-contained because Chrome injects it into the tab. It runs in an isolated world by default; set `world: 'MAIN'` when it needs the page's JavaScript context.

```sh
scripts/invoke automations list
scripts/invoke automations run dismiss-example-banner 4
```
