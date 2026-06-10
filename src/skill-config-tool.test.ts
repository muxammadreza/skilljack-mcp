import { describe, it, expect, vi } from "vitest";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("skill-config-tool", () => {
  it("registers configuration tools with OpenAI-specific metadata", () => {
    const mockRegisterTool = vi.fn();
    const mockRegisterResource = vi.fn();
    const mockServer = {
      registerTool: mockRegisterTool,
      registerResource: mockRegisterResource,
    } as unknown as McpServer;

    const skillState = createTestSkillState([]);
    const onDirectoriesChanged = vi.fn();

    registerSkillConfigTool(mockServer, skillState, onDirectoriesChanged);

    // Should register at least: skill-config, skill-config-add-directory, skill-config-remove-directory,
    // skill-config-add-allowed-org, skill-config-remove-allowed-org, skill-config-set-static-mode
    expect(mockRegisterTool).toHaveBeenCalled();

    const registeredTools = mockRegisterTool.mock.calls.map((call) => ({
      name: call[0],
      config: call[1],
    }));

    const mainConfigTool = registeredTools.find((t) => t.name === "skill-config");
    expect(mainConfigTool).toBeDefined();
    expect(mainConfigTool?.config._meta).toBeDefined();
    expect(mainConfigTool?.config._meta["openai/outputTemplate"]).toBe("ui://skill-config/v1/mcp-app.html");
    expect(mainConfigTool?.config._meta["openai/toolInvocation/invoking"]).toBe("Opening skills configuration...");
    expect(mainConfigTool?.config._meta["openai/toolInvocation/invoked"]).toBe("Skills configuration opened");

    const addDirTool = registeredTools.find((t) => t.name === "skill-config-add-directory");
    expect(addDirTool).toBeDefined();
    expect(addDirTool?.config._meta).toBeDefined();
    expect(addDirTool?.config._meta["openai/outputTemplate"]).toBe("ui://skill-config/v1/mcp-app.html");
    expect(addDirTool?.config._meta["openai/toolInvocation/invoking"]).toBe("Adding skills directory...");
    expect(addDirTool?.config._meta["openai/toolInvocation/invoked"]).toBe("Skills directory added");
  });
});
