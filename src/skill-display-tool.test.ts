import { describe, it, expect, vi } from "vitest";
import { registerSkillDisplayTool } from "./skill-display-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function getRegisteredTools(mockRegisterTool: ReturnType<typeof vi.fn>) {
  return mockRegisterTool.mock.calls.map((call) => ({
    name: call[0],
    config: call[1],
  }));
}

describe("skill-display-tool", () => {
  it("registers the render tool with ChatGPT Apps metadata", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    registerSkillDisplayTool(mockServer, createTestSkillState([]), vi.fn());

    const registeredTools = getRegisteredTools(mockRegisterTool);
    const mainDisplayTool = registeredTools.find((t) => t.name === "skill-display");

    expect(mainDisplayTool).toBeDefined();
    expect(mainDisplayTool?.config._meta?.ui?.resourceUri).toBe("ui://skill-display/v1/skill-display.html");
    expect(mainDisplayTool?.config._meta?.["openai/outputTemplate"]).toBe("ui://skill-display/v1/skill-display.html");
    expect(mainDisplayTool?.config._meta?.["openai/widgetAccessible"]).toBe(true);
    expect(mainDisplayTool?.config._meta?.["openai/toolInvocation/invoking"]).toBe("Opening skill list...");
    expect(mainDisplayTool?.config._meta?.["openai/toolInvocation/invoked"]).toBe("Skill list opened");
  });

  it("registers mutation tools as app-only helpers without UI templates", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    registerSkillDisplayTool(mockServer, createTestSkillState([]), vi.fn());

    const registeredTools = getRegisteredTools(mockRegisterTool);
    const helperTools = registeredTools.filter((t) => t.name !== "skill-display");

    expect(helperTools.length).toBeGreaterThan(0);
    for (const tool of helperTools) {
      expect(tool.config._meta?.ui?.resourceUri).toBe("ui://skill-display/v1/skill-display.html");
      expect(tool.config._meta?.ui?.visibility).toEqual(["app"]);
      expect(tool.config._meta?.["openai/outputTemplate"]).toBeUndefined();
    }
  });
});
