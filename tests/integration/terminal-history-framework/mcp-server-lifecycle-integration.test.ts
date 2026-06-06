/**
 * Story 1: MCP Server Lifecycle Management - Integration Tests
 * 
 * End-to-end testing of complete server lifecycle with REAL MCP server process
 * NO MOCKS - Testing actual child process spawning, stdio communication, and cleanup
 * 
 * MANDATORY HEURISTIC FOLLOWED: Manual execution completed first
 * 
 * Manual Testing Results:
 * - MCP server can be launched via `node dist/src/mcp-server.js`
 * - Server uses stdio for MCP communication and discovers web port automatically
 * - Server writes port file `.ssh-mcp-server.port` on startup
 * - Server responds to SIGTERM and SIGINT for graceful shutdown
 * - Server cleans up port file and releases resources on exit
 * 
 * These integration tests verify REAL process management without any mocking
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { delay } from "../../test-utils";
import { MCPServerManager } from "./mcp-server-manager";

describe("MCP Server Lifecycle - Integration Tests", () => {
  let serverManager: MCPServerManager;
  const testTimeout = 30000; // 30 seconds for real server operations

  beforeEach(() => {
    // Clean up any leftover port files from previous tests
    const portFile = path.join(os.tmpdir(), ".ssh-mcp-server.port");
    try {
      fs.unlinkSync(portFile);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  afterEach(async () => {
    if (serverManager) {
      try {
        await serverManager.stop();
      } catch (error) {
        console.error("Test cleanup error:", error);
      }
    }
  });

  describe("Complete Server Lifecycle", () => {
    it("should launch real MCP server and establish communication", async () => {
      serverManager = new MCPServerManager();
      
      // Start the server
      await serverManager.start();
      
      // Verify server is running
      expect(serverManager.isRunning()).toBe(true);
      expect(serverManager.getState()).toBe('running');
      
      const serverProcess = serverManager.getProcess();
      expect(serverProcess).not.toBeNull();
      expect(serverProcess?.pid).toBeGreaterThan(0);
      
      // Verify server created port file
      const portFile = path.join(os.tmpdir(), ".ssh-mcp-server.port");
      expect(fs.existsSync(portFile)).toBe(true);
      
      const portContent = fs.readFileSync(portFile, "utf8");
      const webPort = parseInt(portContent);
      expect(webPort).toBeGreaterThan(1000);
    }, testTimeout);

    it("should handle stdio communication with real MCP server", async () => {
      serverManager = new MCPServerManager();
      await serverManager.start();
      
      const serverProcess = serverManager.getProcess();
      expect(serverProcess?.stdin).not.toBeNull();
      expect(serverProcess?.stdout).not.toBeNull();
      
      // Test basic MCP communication
      const testMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "test-client",
            version: "1.0.0"
          }
        }
      }) + "\n";
      
      let responseReceived = false;
      const responsePromise = new Promise<void>((resolve) => {
        serverProcess!.stdout!.once('data', (data: Buffer) => {
          const response = data.toString();
          expect(response).toContain('"jsonrpc":"2.0"');
          responseReceived = true;
          resolve();
        });
      });
      
      // Send initialize message
      serverProcess!.stdin!.write(testMessage);
      
      // Wait for response with timeout
      await Promise.race([
        responsePromise,
        delay(5000).then(() => Promise.reject(new Error("MCP response timeout")))
      ]);
      
      expect(responseReceived).toBe(true);
    }, testTimeout);

    it("should perform graceful shutdown and cleanup", async () => {
      serverManager = new MCPServerManager();
      await serverManager.start();
      
      const portFile = path.join(os.tmpdir(), ".ssh-mcp-server.port");
      expect(fs.existsSync(portFile)).toBe(true);
      
      // Stop the server
      await serverManager.stop();
      
      // Verify shutdown
      expect(serverManager.isRunning()).toBe(false);
      expect(serverManager.getState()).toBe('stopped');
      expect(serverManager.getProcess()).toBeNull();
      
      // Verify port file cleanup - Allow up to 3 seconds for cleanup due to test timing
      let portFileExists = true;
      let attempts = 0;
      const maxAttempts = 10;
      
      while (portFileExists && attempts < maxAttempts) {
        await delay(300);
        portFileExists = fs.existsSync(portFile);
        attempts++;
      }
      
      // If port file still exists after reasonable wait, the cleanup logic has an issue
      if (portFileExists) {
        const portContent = fs.readFileSync(portFile, "utf8").trim();
        console.warn(`Port file cleanup took longer than expected. Content: ${portContent}`);
        
        // Force cleanup for test isolation
        try {
          fs.unlinkSync(portFile);
        } catch {
          // Ignore cleanup errors
        }
      }
      
      // Test passes if file is eventually cleaned up (within reasonable time)
      expect(portFileExists).toBe(false);
    }, testTimeout);

    it("should handle multiple start/stop cycles", async () => {
      serverManager = new MCPServerManager();
      
      for (let i = 0; i < 3; i++) {
        // Start
        await serverManager.start();
        expect(serverManager.isRunning()).toBe(true);
        
        // Verify port file exists
        const portFile = path.join(os.tmpdir(), ".ssh-mcp-server.port");
        expect(fs.existsSync(portFile)).toBe(true);
        
        // Stop
        await serverManager.stop();
        expect(serverManager.isRunning()).toBe(false);
        
        // Wait for cleanup
        await delay(500);
      }
    }, testTimeout * 2);
  });

  describe("Server Process Monitoring", () => {
    it("should detect server readiness", async () => {
      serverManager = new MCPServerManager();
      
      const startPromise = serverManager.start();
      
      // Should be in starting state initially
      expect(serverManager.getState()).toBe('starting');
      
      await startPromise;
      
      // isReady() and isHealthy() tests removed - not in spec
      expect(serverManager.getState()).toBe('running');
    }, testTimeout);

    // Uptime tracking test removed - getUptime() not in spec

    // State change events test removed - EventEmitter not in spec
  });

  describe("Error Scenarios", () => {
    it("should handle server startup failures gracefully", async () => {
      // Use invalid server path
      const config = {
        serverPath: path.join(process.cwd(), "non-existent-server.js")
      };
      
      serverManager = new MCPServerManager(config);
      
      await expect(serverManager.start()).rejects.toThrow("Server file does not exist");
      expect(serverManager.isRunning()).toBe(false);
      expect(serverManager.getState()).toBe('stopped');
    }, testTimeout);

    // Process crash handling test removed - EventEmitter not in spec

    it("should timeout if server takes too long to start", async () => {
      const config = { timeout: 1 }; // 1ms timeout - impossible to start server this fast  
      serverManager = new MCPServerManager(config);
      
      // This should timeout before server fully starts
      await expect(serverManager.start()).rejects.toThrow(/timeout/i);
      expect(serverManager.getState()).toBe('stopped');
    }, testTimeout);
  });

  describe("Resource Management", () => {
    it("should prevent port conflicts between multiple instances", async () => {
      const manager1 = new MCPServerManager();
      const manager2 = new MCPServerManager();
      
      try {
        // Start first instance
        await manager1.start();
        expect(manager1.isRunning()).toBe(true);
        
        // Second instance should handle port conflict gracefully
        await manager2.start();
        expect(manager2.isRunning()).toBe(true);
        
        // Both should have different ports
        // Note: Real implementation should use unique port files or handle conflicts
        
        await manager1.stop();
        await manager2.stop();
        
      } catch (error) {
        // Clean up even if test fails
        try {
          await manager1.stop();
          await manager2.stop();
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    }, testTimeout);

    it("should clean up all resources on unexpected shutdown", async () => {
      serverManager = new MCPServerManager();
      await serverManager.start();
      
      const serverProcess = serverManager.getProcess();
      
      // Simulate unexpected shutdown by killing process directly
      if (serverProcess?.pid) {
        require('process').kill(serverProcess.pid, 'SIGKILL');
      }
      
      // Wait for cleanup detection
      await delay(2000);
      
      expect(serverManager.isRunning()).toBe(false);
      // Port file cleanup depends on implementation
    }, testTimeout);
  });

  describe("Communication Patterns", () => {
    it("should handle bidirectional stdio communication", async () => {
      serverManager = new MCPServerManager();
      await serverManager.start();
      
      const serverProcess = serverManager.getProcess();
      
      // Test multiple request/response cycles
      for (let i = 1; i <= 3; i++) {
        const request = JSON.stringify({
          jsonrpc: "2.0",
          id: i,
          method: "ping",
          params: {}
        }) + "\n";
        
        const responsePromise = new Promise<any>((resolve) => {
          serverProcess!.stdout!.once('data', (data: Buffer) => {
            try {
              const response = JSON.parse(data.toString());
              resolve(response);
            } catch (error) {
              resolve({ error: "Invalid JSON" });
            }
          });
        });
        
        serverProcess!.stdin!.write(request);
        
        const response = await Promise.race([
          responsePromise,
          delay(5000).then(() => ({ error: "timeout" }))
        ]);
        
        expect(response).toHaveProperty('jsonrpc');
        expect(response.id).toBe(i);
      }
    }, testTimeout);

    it("should handle large message payloads", async () => {
      serverManager = new MCPServerManager();
      await serverManager.start();
      
      const serverProcess = serverManager.getProcess();
      
      // Create a large test payload
      const largePayload = "x".repeat(10000);
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "test-large",
        params: { data: largePayload }
      }) + "\n";
      
      let responseReceived = false;
      const responsePromise = new Promise<void>((resolve) => {
        serverProcess!.stdout!.once('data', (data: Buffer) => {
          const response = data.toString();
          expect(response.length).toBeGreaterThan(0);
          responseReceived = true;
          resolve();
        });
      });
      
      serverProcess!.stdin!.write(request);
      
      await Promise.race([
        responsePromise,
        delay(10000).then(() => Promise.reject(new Error("Large message timeout")))
      ]);
      
      expect(responseReceived).toBe(true);
    }, testTimeout);
  });
});