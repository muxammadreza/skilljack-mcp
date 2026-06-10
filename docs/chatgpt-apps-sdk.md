# ChatGPT / OpenAI Apps SDK Compatibility

Skilljack supports ChatGPT-compatible MCP Apps UI when it is served over Streamable HTTP.
The original stdio transport remains the default for local desktop MCP clients.

## Local development

Build the server and bundled UI:

```bash
npm install
npm run build
```

Start the Streamable HTTP server:

```bash
npm run start:http
```

By default this exposes:

```text
http://127.0.0.1:3099/mcp
```

Use a tunnel such as ngrok, cloudflared, or another HTTPS reverse proxy to expose that endpoint to ChatGPT during development.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKILLJACK_TRANSPORT` | `stdio` | Set to `http` or `streamable-http` for ChatGPT-compatible HTTP mode. |
| `SKILLJACK_HOST` | `127.0.0.1` | HTTP bind host. Use `0.0.0.0` behind a reverse proxy/container. |
| `SKILLJACK_PORT` | `3099` | HTTP bind port. `PORT` is also respected. |
| `SKILLJACK_MCP_PATH` | `/mcp` | MCP endpoint path. |
| `SKILLJACK_WIDGET_DOMAIN` | unset | Optional stable component origin for production deployments. |

Equivalent CLI flags:

```bash
skilljack-mcp --http
skilljack-mcp --streamable-http
skilljack-mcp --transport=http
```

Skill directories can still be supplied through positional args, `SKILLS_DIR`, or the config UI.

## ChatGPT connector setup

1. Start Skilljack in HTTP mode.
2. Expose the server through HTTPS.
3. In ChatGPT Developer Mode, create a connector using the public MCP URL, for example:

```text
https://example-tunnel.ngrok.app/mcp
```

4. Add the connector to a chat.
5. Test with:

```text
show my skills
```

or:

```text
open skill config
```

## UI compatibility requirements implemented

Skilljack registers two render tools:

- `skill-config`
- `skill-display`

Each render tool includes:

- `_meta.ui.resourceUri`
- `_meta["openai/outputTemplate"]`
- `_meta["openai/widgetAccessible"]`

Each HTML resource is returned as:

```text
text/html;profile=mcp-app
```

Mutation tools used by the iframe are app-only helpers with `_meta.ui.visibility = ["app"]` and do not declare their own `openai/outputTemplate`, preventing duplicate UI cards.

## Smoke checks

```bash
npm run build
npm run test
npm run start:http
curl http://127.0.0.1:3099/healthz
```

Expected health response:

```json
{"ok":true,"transport":"http","path":"/mcp"}
```
