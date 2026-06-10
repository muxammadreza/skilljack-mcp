import { describe, it, expect, vi } from "vitest";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function getRegisteredTools(mockRegisterTool: ReturnType<typeof vi.fn>) {
  return mockRegisterTool.mock.calls.map((call) => ({
    name: call[0],
    config: call[1],
  }));
}

describe("skill-config-tool", () => {
  it("registers the render tool with ChatGPT Apps metadata", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    registerSkillConfigTool(mockServer, createTestSkillState([]), vi.fn());

    const registeredTools = getRegisteredTools(mockRegisterTool);
    const mainConfigTool = registeredTools.find((t) => t.name === "skill-config");

    expect(mainConfigTool).toBeDefined();
    expect(mainConfigTool?.config._meta?.ui?.resourceUri).toBe("ui://skill-config/v2/mcp-app.html");
    expect(mainConfigTool?.config._meta?.["openai/outputTemplate"]).toBe("ui://skill-config/v2/mcp-app.html");
    expect(mainConfigTool?.config._meta?.["openai/widgetAccessible"]).toBe(true);
    expect(mainConfigTool?.config._meta?.["openai/toolInvocation/invoking"]).toBe("Opening skills configuration...");
    expect(mainConfigTool?.config._meta?.["openai/toolInvocation/invoked"]).toBe("Skills configuration opened");
  });

  it("registers mutation tools as app-only helpers without UI templates", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    registerSkillConfigTool(mockServer, createTestSkillState([]), vi.fn());

    const registeredTools = getRegisteredTools(mockRegisterTool);
    const helperTools = registeredTools.filter((t) => t.name !== "skill-config");

    expect(helperTools.length).toBeGreaterThan(0);
    for (const tool of helperTools) {
      expect(tool.config._meta?.ui?.resourceUri).toBe("ui://skill-config/v2/mcp-app.html");
      expect(tool.config._meta?.ui?.visibility).toEqual(["app"]);
      expect(tool.config._meta?.["openai/outputTemplate"]).toBeUndefined();
    }
  });
});
