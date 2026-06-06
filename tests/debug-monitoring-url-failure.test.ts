/**
 * Debug Monitoring URL Failure Test
 * 
 * Purpose: Deep dive into why ssh_get_monitoring_url MCP tool fails
 * in CI environments. The diagnostic test showed this is the exact failure point.
 * 
 * Hypothesis: The MCP server may not be starting the web server component properly
 * in CI environments, leading to missing monitoring URL functionality.
 */

import { MCPServerManager } from './integration/terminal-history-framework/mcp-server-manager';
import { MCPClient } from './integration/terminal-history-framework/mcp-client';
import { execSync } from 'child_process';

describe('Monitoring URL Failure Debug', () => {
  test('Debug ssh_get_monitoring_url failure in detail', async () => {
    console.log('🔍 Starting detailed debugging of monitoring URL failure...\n');
    
    const manager = new MCPServerManager();
    
    try {
      // Step 1: Start MCP server
      console.log('Step 1: Starting MCP server...');
      await manager.start();
      console.log('✅ MCP server started successfully');
      
      const rawProcess = manager.getRawProcess();
      if (!rawProcess) {
        throw new Error('No server process available');
      }
      
      const client = new MCPClient(rawProcess);
      
      // Step 2: Test basic MCP functionality
      console.log('\nStep 2: Testing basic MCP connectivity...');
      const listResponse = await client.callTool('ssh_list_sessions', {});
      console.log(`✅ ssh_list_sessions response: ${JSON.stringify(listResponse)}`);
      
      // Step 3: Create SSH connection
      console.log('\nStep 3: Creating SSH connection...');
      const connectResponse = await client.callTool('ssh_connect', {
        name: 'debug-session',
        host: 'localhost',
        username: process.env.USER || 'jsbattig',
        keyFilePath: `${process.env.HOME}/.ssh/id_ed25519`
      });
      console.log(`SSH connection response: ${JSON.stringify(connectResponse)}`);
      
      if (!connectResponse.success) {
        throw new Error(`SSH connection failed: ${connectResponse.error}`);
      }
      
      // Step 4: Check if web server is running
      console.log('\nStep 4: Checking for web server processes...');
      try {
        const netstatOutput = execSync('netstat -tlnp 2>/dev/null | grep LISTEN | grep node || echo "No node processes listening"', { });
        console.log(`Listening node processes:\n${netstatOutput}`);
      } catch (error) {
        console.log(`Could not check netstat: ${error}`);
      }
      
      // Step 5: Check for .ssh-mcp-server.port file
      console.log('\nStep 5: Checking for port file...');
      try {
        const portFileContent = execSync(`cat ${require('os').tmpdir()}/.ssh-mcp-server.port 2>/dev/null || echo "Port file not found"`, { });
        console.log(`Port file content: ${portFileContent.toString().trim()}`);
      } catch (error) {
        console.log(`Could not read port file: ${error}`);
      }
      
      // Step 6: Wait a moment for web server to initialize
      console.log('\nStep 6: Waiting for web server initialization...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Step 7: Attempt to get monitoring URL with detailed error capture
      console.log('\nStep 7: Attempting to get monitoring URL...');
      try {
        const urlResponse = await client.callTool('ssh_get_monitoring_url', {
          sessionName: 'debug-session'
        });
        
        console.log(`Raw monitoring URL response: ${JSON.stringify(urlResponse, null, 2)}`);
        
        if (urlResponse.success) {
          const monitoringUrl = (urlResponse as any).monitoringUrl;
          if (monitoringUrl) {
            console.log(`✅ SUCCESS: Monitoring URL obtained: ${monitoringUrl}`);
          } else {
            console.log(`❌ ISSUE: Response successful but no monitoring URL in response`);
            console.log(`Response structure: ${JSON.stringify(urlResponse, null, 2)}`);
          }
        } else {
          console.log(`❌ FAILURE: Tool call failed`);
          console.log(`Error: ${urlResponse.error || 'Unknown error'}`);
          console.log(`Full response: ${JSON.stringify(urlResponse, null, 2)}`);
        }
      } catch (urlError) {
        console.log(`❌ EXCEPTION: Monitoring URL call threw exception`);
        console.log(`Exception: ${urlError instanceof Error ? urlError.message : String(urlError)}`);
      }
      
      // Step 8: Check server logs/output
      console.log('\nStep 8: Checking for server stderr output...');
      if (rawProcess.stderr) {
        let stderrOutput = '';
        rawProcess.stderr.on('data', (data) => {
          stderrOutput += data.toString();
        });
        
        // Give a moment for any stderr to accumulate
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (stderrOutput.trim()) {
          console.log(`Server stderr output:\n${stderrOutput}`);
        } else {
          console.log('No stderr output from server');
        }
      }
      
      // Step 9: Check if we can manually list all available tools
      console.log('\nStep 9: Listing all available MCP tools...');
      try {
        // Try to call tools/list if it exists
        const toolsListResponse = await client.callTool('tools/list', {});
        console.log(`Available tools: ${JSON.stringify(toolsListResponse, null, 2)}`);
      } catch (toolsError) {
        console.log(`Could not list tools: ${toolsError instanceof Error ? toolsError.message : String(toolsError)}`);
      }
      
      await client.disconnect();
      
    } catch (error) {
      console.log(`\n❌ CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
    } finally {
      await manager.stop();
    }
    
    console.log('\n🔍 Debug analysis complete. Check output for specific failure point.');
  }, 30000); // 30 second timeout
});