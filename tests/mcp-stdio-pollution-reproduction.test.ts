/**
 * TDD Reproduction Test: MCP Server Stdio Pollution Issue
 * 
 * CRITICAL BUG: SSH Connection Manager constructor outputs console.log to stdout,
 * corrupting MCP JSON-RPC communication over stdio transport.
 * 
 * Expected Error: "Expected substring: \"\"jsonrpc\":\"2.0\"\" 
 * Received string: "🏗️ SSH CONNECTION MANAGER CONSTRUCTED\n""
 * 
 * This test reproduces the exact failure scenario with strict TDD methodology.
 */

import { spawn, ChildProcess } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

describe("MCP Server Stdio Pollution - TDD Reproduction", () => {
  let serverProcess: ChildProcess;

  afterEach(async () => {
    if (serverProcess?.pid) {
      serverProcess.kill('SIGTERM');
      // Wait for cleanup
      await new Promise<void>((resolve) => {
        serverProcess.once('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }
  });

  describe("FAILING TEST - Stdio Pollution Detection", () => {
    it("should detect stdout pollution in MCP server initialization", async () => {
      // FAILING TEST: This should fail because of stdout pollution
      
      const serverPath = path.join(process.cwd(), "dist/src/mcp-server.js");
      
      // Ensure server file exists
      expect(fs.existsSync(serverPath)).toBe(true);
      
      // Start MCP server process
      serverProcess = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env }
      });

      // Test that first stdout output is clean JSON-RPC, not construction message
      const firstOutputPromise = new Promise<string>((resolve) => {
        serverProcess.stdout!.once('data', (data: Buffer) => {
          resolve(data.toString());
        });
      });

      // Send initialize message to trigger server response
      const initMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize", 
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      }) + "\n";

      serverProcess.stdin!.write(initMessage);

      // Wait for first output with timeout
      const firstOutput = await Promise.race([
        firstOutputPromise,
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error("No server output within timeout")), 5000)
        )
      ]);

      // ASSERTION THAT SHOULD FAIL: First output should be JSON, not construction message
      expect(firstOutput).toContain('"jsonrpc":"2.0"');
      expect(firstOutput).not.toContain('🏗️ SSH CONNECTION MANAGER CONSTRUCTED');
      
      // Additional validation: Ensure it's valid JSON-RPC
      try {
        const parsed = JSON.parse(firstOutput.trim());
        expect(parsed).toHaveProperty('jsonrpc', '2.0');
        expect(parsed).toHaveProperty('id', 1);
      } catch (error) {
        fail(`First output is not valid JSON: ${firstOutput}`);
      }
    }, 10000);

    it("should maintain clean stdio channel for all MCP communication", async () => {
      // FAILING TEST: Verify no pollution in subsequent communication
      
      const serverPath = path.join(process.cwd(), "dist/src/mcp-server.js");
      
      serverProcess = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env }
      });

      let outputCount = 0;
      const outputs: string[] = [];

      // Collect multiple outputs
      const outputCollector = (data: Buffer) => {
        const output = data.toString();
        outputs.push(output);
        outputCount++;
      };

      serverProcess.stdout!.on('data', outputCollector);

      // Send multiple MCP messages
      const messages = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ssh_list_sessions", arguments: {} } }
      ];

      for (const message of messages) {
        serverProcess.stdin!.write(JSON.stringify(message) + "\n");
        // Wait between messages
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for responses
      await new Promise(resolve => setTimeout(resolve, 1000));

      // ASSERTIONS THAT SHOULD FAIL: All outputs should be clean JSON-RPC
      expect(outputs.length).toBeGreaterThan(0);
      
      // Join all outputs and check for pollution
      const allOutput = outputs.join('');
      expect(allOutput).not.toContain('🏗️');
      expect(allOutput).not.toContain('SSH CONNECTION MANAGER CONSTRUCTED');
      
      // Split concatenated JSON responses by newlines and validate each
      const jsonLines = allOutput.split('\n').filter(line => line.trim());
      
      for (let i = 0; i < jsonLines.length; i++) {
        const line = jsonLines[i].trim();
        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line);
            expect(parsed).toHaveProperty('jsonrpc', '2.0');
          } catch (error) {
            throw new Error(`JSON line ${i} is not valid: "${line}"`);
          }
        }
      }
    }, 10000);
  });

  describe("Port File Management - TDD Reproduction", () => {
    it("should create port file with proper format and location", async () => {
      // FAILING TEST: Verify port file creation during server startup
      
      const serverPath = path.join(process.cwd(), "dist/src/mcp-server.js");
      const portFilePath = path.join(os.tmpdir(), ".ssh-mcp-server.port");
      
      // Clean up any existing port file
      try {
        fs.unlinkSync(portFilePath);
      } catch {
        // Ignore if doesn't exist
      }

      serverProcess = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env }
      });

      // Wait for server initialization
      await new Promise(resolve => setTimeout(resolve, 2000));

      // ASSERTIONS THAT MIGHT FAIL: Port file should exist with valid content
      expect(fs.existsSync(portFilePath)).toBe(true);
      
      const portContent = fs.readFileSync(portFilePath, "utf8").trim();
      const portNumber = parseInt(portContent);
      
      expect(portNumber).toBeGreaterThan(1000);
      expect(portNumber).toBeLessThan(65536);
      expect(isNaN(portNumber)).toBe(false);
    }, 10000);
  });
});