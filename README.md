# Skilljack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

## Installation

```bash
npm install @skilljack/mcp
```

Or run directly with npx:

```bash
npx @skilljack/mcp /path/to/skills
```

### From Source

```bash
git clone https://github.com/olaservo/skilljack-mcp.git
cd skilljack-mcp
npm install
npm run build
```

## Usage

```bash
# Single directory
skilljack-mcp /path/to/skills

# Multiple directories
skilljack-mcp /path/to/skills /path/to/more/skills

# Using environment variable
SKILLS_DIR=/path/to/skills skilljack-mcp

# Static mode (no file watching)
skilljack-mcp --static /path/to/skills

# Streamable HTTP mode for ChatGPT connectors / remote MCP clients
skilljack-mcp --http

# Or via npm script after building
npm run start:http
```

## Configuration and Skills Display UI

This server includes an MCP Apps UI for clients that support embedded MCP app resources. Instead of editing config files or environment variables manually, you can configure skill locations and skill visibility directly in your chat window.

For ChatGPT, run Skilljack as a Streamable HTTP MCP server and connect ChatGPT to the public HTTPS `/mcp` endpoint. See [docs/chatgpt-apps-sdk.md](docs/chatgpt-apps-sdk.md).

(Screenshots below are from a dark-mode MCP client.)

![Skills Configuration UI](docs/images/skills-config-ui.png)

![Skill Display UI](docs/images/skill-display-ui.png)

## Documentation

For complete documentation, just ask your assistant:

> "how do I use skilljack?" or "how does skilljack work behind the scenes?"

This loads the [full reference](https://github.com/olaservo/skilljack-mcp/blob/main/skills/skilljack-docs/SKILL.md) including tools, prompts, resources, configuration options, and architecture details.

## Related

- [Agent Skills Specification](https://agentskills.io)
- [Skills Over MCP Interest Group repository](https://github.com/modelcontextprotocol/experimental-ext-skills)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
