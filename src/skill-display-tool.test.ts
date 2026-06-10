import { describe, it, expect, vi } from "vitest";
import { registerSkillDisplayTool } from "./skill-display-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("skill-display-tool", () => {
  it("registers display tools with OpenAI-specific metadata", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    const skillState = createTestSkillState([]);
    const onInvocationChanged = vi.fn();

    registerSkillDisplayTool(mockServer, skillState, onInvocationChanged);

    // Should register: skill-display, skill-display-update-invocation, skill-display-reset-override
    expect(mockRegisterTool).toHaveBeenCalled();

    const registeredTools = mockRegisterTool.mock.calls.map((call) => ({
      name: call[0],
      config: call[1],
    }));

    const mainDisplayTool = registeredTools.find((t) => t.name === "skill-display");
    expect(mainDisplayTool).toBeDefined();
    expect(mainDisplayTool?.config._meta).toBeDefined();
    expect(mainDisplayTool?.config._meta["openai/outputTemplate"]).toBe("ui://skill-display/v1/skill-display.html");
    expect(mainDisplayTool?.config._meta["openai/toolInvocation/invoking"]).toBe("Opening skill list...");
    expect(mainDisplayTool?.config._meta["openai/toolInvocation/invoked"]).toBe("Skill list opened");

    const updateInvocationTool = registeredTools.find((t) => t.name === "skill-display-update-invocation");
    expect(updateInvocationTool).toBeDefined();
    expect(updateInvocationTool?.config._meta).toBeDefined();
    expect(updateInvocationTool?.config._meta["openai/outputTemplate"]).toBe("ui://skill-display/v1/skill-display.html");
    expect(updateInvocationTool?.config._meta["openai/toolInvocation/invoking"]).toBe("Updating skill invocation settings...");
    expect(updateInvocationTool?.config._meta["openai/toolInvocation/invoked"]).toBe("Skill invocation settings updated");
  });
});
