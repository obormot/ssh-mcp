/**
 * Story 6: Comprehensive Response Collection and Output - Integration Tests
 * 
 * Integration tests for ComprehensiveResponseCollector that test the complete
 * terminal history testing framework workflow with real components.
 * 
 * CRITICAL: NO MOCKS in integration tests - tests real workflow end-to-end.
 * 
 * This validates the complete Stories 1-6 integration:
 * - Story 1: MCP Server lifecycle management
 * - Story 2: Pre-WebSocket command execution
 * - Story 3: WebSocket connection discovery
 * - Story 4: Initial history replay capture
 * - Story 5: Post-WebSocket command execution
 * - Story 6: Comprehensive response collection and orchestration
 */

import { ComprehensiveResponseCollector, ComprehensiveResponseCollectorConfig } from './comprehensive-response-collector';
import { MCPServerManager, MCPServerConfig } from './mcp-server-manager';
import { MCPClient } from './mcp-client';
import { PreWebSocketCommandExecutor } from './pre-websocket-command-executor';
import { WebSocketConnectionDiscovery } from './websocket-connection-discovery';
import { InitialHistoryReplayCapture } from './initial-history-replay-capture';
import { PostWebSocketCommandExecutor } from './post-websocket-command-executor';
import * as os from 'os';
import * as path from 'path';

describe('ComprehensiveResponseCollector Integration', () => {
  let collector: ComprehensiveResponseCollector;
  let serverManager: MCPServerManager;
  
  // Integration test timeout - longer for real components
  jest.setTimeout(120000);

  beforeEach(() => {
    // Clean up any existing server processes
    const portFilePath = path.join(os.tmpdir(), '.ssh-mcp-server.port');
    try {
      require('fs').unlinkSync(portFilePath);
    } catch {
      // Port file might not exist
    }
  });

  afterEach(async () => {
    // Ensure cleanup
    if (collector) {
      await collector.cleanup();
    }
    if (serverManager) {
      await serverManager.stop();
    }
  });

  describe('complete workflow integration', () => {
    it('should execute complete Stories 1-6 workflow with real components', async () => {
      // Create real components (no mocks)
      const serverConfig: MCPServerConfig = {
        serverPath: path.join(process.cwd(), "dist/src/mcp-server.js"),
        timeout: 30000,
        port: 0 // Auto-discover
      };

      const workflowConfig: ComprehensiveResponseCollectorConfig = {
        sessionName: 'integration-test-session',
        workflowTimeout: 60000,
        preWebSocketCommands: [
          { tool: 'ssh_create_session', args: { sessionName: 'integration-test-session' } },
          { tool: 'ssh_exec', args: { command: 'echo "Pre-WebSocket test"', sessionName: 'integration-test-session' } }
        ],
        postWebSocketCommands: [
          {initiator: 'mcp-client', command: 'ssh_exec echo "Post-WebSocket test"'}
        ],
        historyReplayTimeout: 10000,
        commandTimeout: 30000
      };

      collector = new ComprehensiveResponseCollector(workflowConfig);
      serverManager = new MCPServerManager(serverConfig);

      // Start server first to get process
      await serverManager.start();

      // Create real component instances
      const mcpClient = new MCPClient(serverManager.getRawProcess()!);
      const preWebSocketExecutor = new PreWebSocketCommandExecutor(mcpClient);
      const connectionDiscovery = new WebSocketConnectionDiscovery(mcpClient);
      const historyCapture = new InitialHistoryReplayCapture(connectionDiscovery);
      const postWebSocketExecutor = new PostWebSocketCommandExecutor(mcpClient, historyCapture);

      // Set components in collector
      collector.setServerManager(serverManager);
      collector.setMcpClient(mcpClient);
      collector.setPreWebSocketExecutor(preWebSocketExecutor);
      collector.setConnectionDiscovery(connectionDiscovery);
      collector.setHistoryCapture(historyCapture);
      collector.setPostWebSocketExecutor(postWebSocketExecutor);

      // Execute complete workflow
      const result = await collector.executeComprehensiveWorkflow();

      // Validate workflow results
      expect(result.success).toBe(true);
      expect(result.concatenatedResponses).toBeDefined();
      expect(result.concatenatedResponses.length).toBeGreaterThan(0);
      expect(result.totalExecutionTime).toBeGreaterThan(0);
      expect(result.phaseBreakdown).toBeDefined();
      
      // Verify CRLF preservation (critical for terminal display)
      expect(result.concatenatedResponses.includes('\r\n')).toBe(true);
      
      // Verify phase separation
      expect(result.phaseBreakdown!.historyMessageCount).toBeGreaterThanOrEqual(0);
      expect(result.phaseBreakdown!.realTimeMessageCount).toBeGreaterThanOrEqual(0);
      expect(result.phaseBreakdown!.historyReplayMessages).toBeDefined();
      expect(result.phaseBreakdown!.realTimeMessages).toBeDefined();
      
      // Verify workflow phases were executed
      expect(result.phaseBreakdown!.serverLaunchSuccess).toBe(true);
      expect(result.phaseBreakdown!.preWebSocketCommandsSuccess).toBe(true);
      expect(result.phaseBreakdown!.webSocketConnectionSuccess).toBe(true);
      expect(result.phaseBreakdown!.historyReplayCaptureSuccess).toBe(true);
      expect(result.phaseBreakdown!.postWebSocketCommandsSuccess).toBe(true);
    });

    it('should handle server startup failures gracefully', async () => {
      const serverConfig: MCPServerConfig = {
        serverPath: '/nonexistent/path/to/server.js', // Invalid path
        timeout: 5000
      };

      const workflowConfig: ComprehensiveResponseCollectorConfig = {
        sessionName: 'failure-test-session',
        workflowTimeout: 10000
      };

      collector = new ComprehensiveResponseCollector(workflowConfig);
      serverManager = new MCPServerManager(serverConfig);

      // For failure tests, we only set the server manager
      // The workflow will fail at server startup, which is what we want to test
      collector.setServerManager(serverManager);

      // Create dummy components with null processes - they won't be used since server fails first
      const mockProcess = { stdin: { write: jest.fn(), end: jest.fn(), destroy: jest.fn(), destroyed: false }, stdout: { on: jest.fn(), destroy: jest.fn(), destroyed: false }, stderr: { on: jest.fn(), destroy: jest.fn(), destroyed: false }, on: jest.fn(), removeAllListeners: jest.fn(), kill: jest.fn(), killed: false, pid: 12345 } as any;
      const mcpClient = new MCPClient(mockProcess);
      const preWebSocketExecutor = new PreWebSocketCommandExecutor(mcpClient);
      const connectionDiscovery = new WebSocketConnectionDiscovery(mcpClient);
      const historyCapture = new InitialHistoryReplayCapture(connectionDiscovery);
      const postWebSocketExecutor = new PostWebSocketCommandExecutor(mcpClient, historyCapture);

      collector.setMcpClient(mcpClient);
      collector.setPreWebSocketExecutor(preWebSocketExecutor);
      collector.setConnectionDiscovery(connectionDiscovery);
      collector.setHistoryCapture(historyCapture);
      collector.setPostWebSocketExecutor(postWebSocketExecutor);

      const result = await collector.executeComprehensiveWorkflow();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server file does not exist');
      expect(result.phaseBreakdown!.serverLaunchSuccess).toBe(false);
    });

    it('should handle workflow timeout scenarios', async () => {
      const serverConfig: MCPServerConfig = {
        serverPath: path.join(process.cwd(), "dist/src/mcp-server.js"),
        timeout: 30000
      };

      const workflowConfig: ComprehensiveResponseCollectorConfig = {
        sessionName: 'timeout-test-session',
        workflowTimeout: 2000, // Very short timeout
        preWebSocketCommands: [
          { tool: 'ssh_create_session', args: { sessionName: 'timeout-test-session' } }
        ]
      };

      collector = new ComprehensiveResponseCollector(workflowConfig);
      serverManager = new MCPServerManager(serverConfig);

      // Start server first
      await serverManager.start();

      const mcpClient = new MCPClient(serverManager.getRawProcess()!);
      const preWebSocketExecutor = new PreWebSocketCommandExecutor(mcpClient);
      const connectionDiscovery = new WebSocketConnectionDiscovery(mcpClient);
      const historyCapture = new InitialHistoryReplayCapture(connectionDiscovery);
      const postWebSocketExecutor = new PostWebSocketCommandExecutor(mcpClient, historyCapture);

      collector.setServerManager(serverManager);
      collector.setMcpClient(mcpClient);
      collector.setPreWebSocketExecutor(preWebSocketExecutor);
      collector.setConnectionDiscovery(connectionDiscovery);
      collector.setHistoryCapture(historyCapture);
      collector.setPostWebSocketExecutor(postWebSocketExecutor);

      const result = await collector.executeComprehensiveWorkflow();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Workflow timeout');
      expect(result.totalExecutionTime).toBeGreaterThanOrEqual(2000);
    });

    it('should preserve exact formatting including CRLF line endings', async () => {
      const serverConfig: MCPServerConfig = {
        serverPath: path.join(process.cwd(), "dist/src/mcp-server.js"),
        timeout: 30000
      };

      const workflowConfig: ComprehensiveResponseCollectorConfig = {
        sessionName: 'crlf-test-session',
        workflowTimeout: 45000,
        preWebSocketCommands: [
          { tool: 'ssh_create_session', args: { sessionName: 'crlf-test-session' } },
          { tool: 'ssh_exec', args: { command: 'echo -e "Line 1\\nLine 2"', sessionName: 'crlf-test-session' } }
        ],
        postWebSocketCommands: [
          {initiator: 'mcp-client', command: 'ssh_exec echo "Real-time line"'}
        ],
        historyReplayTimeout: 8000
      };

      collector = new ComprehensiveResponseCollector(workflowConfig);
      serverManager = new MCPServerManager(serverConfig);

      // Start server first
      await serverManager.start();

      const mcpClient = new MCPClient(serverManager.getRawProcess()!);
      const preWebSocketExecutor = new PreWebSocketCommandExecutor(mcpClient);
      const connectionDiscovery = new WebSocketConnectionDiscovery(mcpClient);
      const historyCapture = new InitialHistoryReplayCapture(connectionDiscovery);
      const postWebSocketExecutor = new PostWebSocketCommandExecutor(mcpClient, historyCapture);

      collector.setServerManager(serverManager);
      collector.setMcpClient(mcpClient);
      collector.setPreWebSocketExecutor(preWebSocketExecutor);
      collector.setConnectionDiscovery(connectionDiscovery);
      collector.setHistoryCapture(historyCapture);
      collector.setPostWebSocketExecutor(postWebSocketExecutor);

      const result = await collector.executeComprehensiveWorkflow();

      expect(result.success).toBe(true);
      expect(result.concatenatedResponses).toBeDefined();
      
      // Critical: Verify CRLF line endings are preserved (required for xterm.js)
      expect(result.concatenatedResponses.includes('\r\n')).toBe(true);
      expect(result.concatenatedResponses.includes('Line 1')).toBe(true);
      expect(result.concatenatedResponses.includes('Line 2')).toBe(true);
      expect(result.concatenatedResponses.includes('Real-time line')).toBe(true);
      
      // Ensure no line ending corruption
      expect(result.concatenatedResponses.includes('\n\r')).toBe(false);
    });

    it('should provide comprehensive resource cleanup', async () => {
      const serverConfig: MCPServerConfig = {
        serverPath: path.join(process.cwd(), "dist/src/mcp-server.js"),
        timeout: 30000
      };

      const workflowConfig: ComprehensiveResponseCollectorConfig = {
        sessionName: 'cleanup-test-session',
        workflowTimeout: 30000,
        preWebSocketCommands: [
          { tool: 'ssh_create_session', args: { sessionName: 'cleanup-test-session' } }
        ]
      };

      collector = new ComprehensiveResponseCollector(workflowConfig);
      serverManager = new MCPServerManager(serverConfig);

      // Start server first
      await serverManager.start();

      const mcpClient = new MCPClient(serverManager.getRawProcess()!);
      const preWebSocketExecutor = new PreWebSocketCommandExecutor(mcpClient);
      const connectionDiscovery = new WebSocketConnectionDiscovery(mcpClient);
      const historyCapture = new InitialHistoryReplayCapture(connectionDiscovery);
      const postWebSocketExecutor = new PostWebSocketCommandExecutor(mcpClient, historyCapture);

      collector.setServerManager(serverManager);
      collector.setMcpClient(mcpClient);
      collector.setPreWebSocketExecutor(preWebSocketExecutor);
      collector.setConnectionDiscovery(connectionDiscovery);
      collector.setHistoryCapture(historyCapture);
      collector.setPostWebSocketExecutor(postWebSocketExecutor);

      const result = await collector.executeComprehensiveWorkflow();
      
      // Verify workflow completes
      expect(result).toBeDefined();
      
      // Explicit cleanup
      await collector.cleanup();
      
      // Verify server is stopped
      expect(serverManager.isRunning()).toBe(false);
      
      // Verify no hanging processes (this is critical for Jest not hanging)
      // The test completion itself validates that cleanup was successful
    });
  });
});