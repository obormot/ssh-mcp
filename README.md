# SSH MCP Server

A Model Context Protocol (MCP) server that provides SSH session management for Claude Code with browser-based terminal monitoring.

## Features

### Core Functionality
- **Persistent SSH Sessions** - Named SSH connections that maintain state across commands
- **Interactive Terminal Interface** - Full browser-based terminal with keyboard input and command execution
- **Multi-Session Support** - Manage multiple independent SSH sessions simultaneously
- **Real-time Output Streaming** - Live terminal output via WebSocket with single clean display
- **Command History** - Track executed commands with timestamps and exit codes
- **Session Isolation** - Each session maintains separate terminal history and state

### Interactive Terminal Capabilities
- **Direct Command Input** - Type commands directly in the browser terminal interface
- **Local Echo** - Immediate character display with terminal cursor movement
- **Command Line Editing** - Full keyboard navigation (arrows, Home, End, backspace)
- **Terminal State Management** - Smart locking/unlocking based on command execution status
- **Source Attribution** - Commands from browser users vs Claude Code are properly tracked
- **Concurrent Execution** - User and Claude Code commands execute through shared SSH session with queuing

### Advanced Features
- **Multiple Authentication Methods** - SSH keys (encrypted/unencrypted), username/password, direct key content
- **Command Queuing** - FIFO execution prevents output interleaving between user and Claude Code commands
- **WebSocket Communication** - Bidirectional messaging for command execution and output streaming
- **Session State Synchronization** - Multiple browser clients stay in sync with terminal state
- **Clean Terminal Display** - Single output with preserved ANSI colors and formatting

## Installation & Setup

### Prerequisites

- Node.js 16+ and npm
- Claude Code CLI installed and configured
- SSH server access (for remote connections)
- TypeScript (for development)

### 1. Clone and Build

```bash
git clone <repository-url> ls-ssh-mcp
cd ls-ssh-mcp
npm install
npm run build
```

### 2. Register with Claude Code

```bash
# Use the installation script (recommended)
./install-mcp.sh

# Or manually register
claude mcp add ssh node /absolute/path/to/ls-ssh-mcp/dist/src/mcp-server.js
```

### 3. Verify Installation

```bash
# Check that the server was registered
claude mcp list
```

**How it works:**
- The `install-mcp.sh` script **registers** the server with Claude Code with an auto-discovered port
- Claude Code **automatically starts** the server when you use SSH tools
- No need to manually start/stop - the server runs on-demand
- Web monitoring interface is available at `http://localhost:{port}/session/{session-name}`

The installation script handles port discovery, cleanup of existing configurations, and proper registration.

## Usage

### Basic Workflow

1. **Connect to SSH server**: Use `ssh_connect` with your credentials
2. **Execute commands**: Use `ssh_exec` to run commands on the remote server  
3. **Monitor sessions**: Use `ssh_get_monitoring_url` to get browser monitoring URL
4. **Manage sessions**: Use `ssh_list_sessions` and `ssh_disconnect` as needed

### Available MCP Tools

| Tool | Purpose | Required Parameters |
|------|---------|-------------------|
| `ssh_connect` | Establish SSH connection | `name`, `host`, `username`, auth method*; optional `port` (default: 22) |
| `ssh_exec` | Execute commands on remote server | `sessionName`, `command` |
| `ssh_list_sessions` | List all active SSH sessions | None |
| `ssh_get_monitoring_url` | Get browser monitoring URL | `sessionName` |
| `ssh_disconnect` | Disconnect an SSH session | `sessionName` |

\* **Authentication methods**: Choose one:
- `password` - SSH user account password
- `privateKey` - Direct private key content (+ optional `passphrase` if key is encrypted)  
- `keyFilePath` - Path to private key file (+ optional `passphrase` if key is encrypted)

### Example Usage

```bash
# 1. Connect to a server (multiple authentication methods)

# Option A: Username/password authentication
ssh_connect name="myserver" host="example.com" username="user" password="pass"

# Option B: SSH key file (recommended)
ssh_connect name="myserver" host="example.com" username="user" keyFilePath="~/.ssh/id_rsa"

# Option C: SSH key file with passphrase (encrypted key)
ssh_connect name="myserver" host="example.com" username="user" keyFilePath="~/.ssh/id_ed25519" passphrase="mypassphrase"

# Option D: Direct private key content (unencrypted)
ssh_connect name="myserver" host="example.com" username="user" privateKey="-----BEGIN OPENSSH PRIVATE KEY-----..."

# Option E: Direct private key content (encrypted with passphrase)
ssh_connect name="myserver" host="example.com" username="user" privateKey="-----BEGIN OPENSSH PRIVATE KEY-----..." passphrase="keypassword"

# Option F: Non-default SSH port
ssh_connect name="myserver" host="example.com" username="user" keyFilePath="~/.ssh/id_ed25519" port=2222

# 2. Execute commands
ssh_exec sessionName="myserver" command="ls -la"
ssh_exec sessionName="myserver" command="htop"

# 3. Get monitoring URL for real-time terminal
ssh_get_monitoring_url sessionName="myserver"
# Returns: http://localhost:8082/session/myserver

# 4. List all active sessions
ssh_list_sessions

# 5. Disconnect when done
ssh_disconnect sessionName="myserver"
```

### Interactive Web Terminal

The browser interface provides a fully interactive terminal experience:

#### Terminal Input & Navigation
- **Direct Command Input** - Type commands directly in the terminal, just like a native SSH client
- **Local Echo** - Characters appear immediately as you type with cursor movement
- **Command Line Editing** - Use arrow keys, Home, End, and backspace for full editing
- **Terminal Locking** - Interface locks during command execution, unlocks when complete

#### Real-time Features
- **Live Output Streaming** - See command results in real-time via WebSocket
- **Concurrent Commands** - User-typed commands and Claude Code commands execute seamlessly
- **Session Synchronization** - Multiple browser windows stay synchronized
- **Command History** - Complete history with timestamps and exit codes

#### Advanced Capabilities
- **Source Attribution** - Terminal tracks whether commands came from user input or Claude Code
- **Queue Management** - Commands execute in order without output mixing
- **State Persistence** - Session state maintained across browser reconnects
- **Clean Output Display** - Single command output without duplication or formatting issues

**Usage**: Navigate to the monitoring URL and interact with the terminal exactly like a local SSH session. Type commands, press Enter, and see results instantly. Claude Code can also execute commands in the same session without interference.

## SSH Authentication Methods

The server supports multiple SSH authentication methods with automatic fallback:

### 1. SSH Key Files (Recommended)
- **Best for**: Regular usage, automated deployments, security-conscious users
- **Supports**: RSA, ED25519, ECDSA key formats
- **Encryption**: Both encrypted (with passphrase) and unencrypted keys
- **Path expansion**: Supports tilde expansion (`~/.ssh/id_rsa`)

```bash
# Unencrypted key
ssh_connect name="prod" host="server.com" username="deploy" keyFilePath="~/.ssh/id_ed25519"

# Encrypted key with passphrase
ssh_connect name="secure" host="server.com" username="admin" keyFilePath="~/.ssh/id_rsa" passphrase="mysecretpass"
```

### 2. Username/Password
- **Best for**: Quick testing, one-off connections, legacy systems
- **Security note**: Less secure than key-based authentication

```bash
ssh_connect name="test" host="server.com" username="user" password="password"
```

### 3. Direct Private Key Content (Legacy)
- **Best for**: Programmatic usage, CI/CD systems with key management
- **Note**: Requires pasting full private key content

```bash
ssh_connect name="ci" host="server.com" username="deploy" privateKey="-----BEGIN OPENSSH PRIVATE KEY-----..."
```

### Authentication Priority
1. `privateKey` (if provided) - highest priority
2. `keyFilePath` (if provided) - recommended method
3. `password` (if provided) - fallback method

## Configuration

### Environment Variables

- `SSH_TIMEOUT` - SSH operation timeout in milliseconds (default: 30000)
- `MAX_SESSIONS` - Maximum concurrent SSH sessions (default: 10)
- `LOG_LEVEL` - Logging level: 'error', 'warn', 'info', 'debug' (default: 'info')

Web server port is automatically discovered and managed by the installation script.

## Development

### Setup Development Environment

```bash
# Install dependencies
npm install

# Run in development mode with auto-reload
npm run dev

# Run tests
npm test

# Run E2E tests (requires SSH server on localhost)
npm run test:e2e

# Build for production
npm run build

# Lint code
npm run lint
```

### Testing Requirements

For running tests, you need:

- SSH server running on localhost
- Test user account: `test_user` with password `password123`
- Or configure your own test credentials in the test files

### Project Structure

```
├── src/
│   ├── mcp-server.ts              # Main server orchestrator
│   ├── mcp-ssh-server.ts          # MCP protocol handler  
│   ├── web-server-manager.ts      # Web interface server + WebSocket handlers
│   ├── ssh-connection-manager.ts  # SSH session management + command queuing
│   └── types.ts                   # TypeScript definitions + command source types
├── static/                        # Interactive xterm.js terminal interface
│   ├── terminal-input-handler.js  # Browser input handling and state management
│   └── [xterm.js assets]          # Terminal rendering components
├── plans/
│   ├── interactive-terminal-epic.md # Complete implementation documentation
│   └── [other planning docs]      # Additional project planning
├── tests/                         # Comprehensive test suite
│   ├── story*.test.ts             # User story validation tests
│   ├── e2e-*.test.ts             # End-to-end functionality tests
│   └── manual-tests/             # Manual testing scripts and plans
├── install-mcp.sh                 # Installation script
└── dist/                          # Compiled output
```

## Security Considerations

- SSH sessions are kept in memory only
- Credentials are not persisted
- Web interface runs on localhost by default
- Use SSH key authentication when possible

## Architecture

### Overall Design

The SSH MCP Server implements a sophisticated architecture that seamlessly integrates Claude Code's MCP tools with interactive browser terminals:

```
┌─────────────────┐    stdio    ┌─────────────────┐    WebSocket    ┌─────────────────┐
│   Claude Code   │◄──────────►│   MCP Server    │◄──────────────►│ Browser Terminal│
└─────────────────┘   commands  └─────────────────┘   bidirectional └─────────────────┘
                                          │
                                          ▼
                                ┌─────────────────┐
                                │ SSH Connection  │
                                │    Manager      │
                                │  (with Queue)   │
                                └─────────────────┘
                                          │
                                          ▼ 
                                ┌─────────────────┐
                                │  Remote SSH     │
                                │     Server      │
                                └─────────────────┘
```

### Core Components

- **MCP Server**: Handles Claude Code communication via stdio protocol (no network port)
- **Web Server**: Provides interactive terminal interface via HTTP and WebSocket  
- **SSH Connection Manager**: Centralized session management with command queuing
- **Interactive Terminal**: Browser-based xterm.js interface with input handling

### Key Architectural Features

#### 1. **Unified Command Execution**
- Both Claude Code tools and browser user input execute through the same SSH sessions
- Commands are queued in FIFO order to prevent output interleaving
- Source attribution tracks whether commands came from "user" or "claude"

#### 2. **Real-time Communication**
- **MCP Protocol**: stdio transport between Claude Code and server
- **WebSocket**: Bidirectional communication between browser and server
- **SSH Connection**: Persistent shell channels with streaming output

#### 3. **State Management**
- **Session Persistence**: SSH sessions maintain state across all command sources
- **Terminal Synchronization**: Multiple browser clients stay synchronized
- **Queue Management**: Commands execute sequentially with proper cleanup

### Port Management

- **MCP Communication**: Uses stdio transport only (stdin/stdout with Claude Code)
- **Web Interface**: Single auto-discovered port serves both HTTP routes and WebSocket connections
- **Port Discovery**: Installation script discovers available port and stores as `WEB_PORT` environment variable
- **URL Generation**: MCP tools return monitoring URLs pointing to the web interface

### Interactive Terminal Architecture

#### Browser-Side Components
- **xterm.js Terminal**: Renders terminal interface with full VT100 compatibility
- **Input Handler**: Manages keyboard input, local echo, and command submission
- **WebSocket Client**: Handles bidirectional communication with server
- **State Manager**: Tracks terminal lock/unlock state and command execution

#### Server-Side Processing
- **WebSocket Handler**: Processes terminal input messages from browser
- **Command Router**: Routes commands to SSH connection manager with source attribution
- **Output Broadcaster**: Streams command results back to all connected clients
- **Queue Coordinator**: Ensures proper execution order for mixed command sources

### Deployment Modes

- **Production**: Claude Code automatically starts server on-demand when SSH tools are used
- **Development**: Manual testing with independent port discovery
- **Interactive Mode**: Browser clients can connect and interact with existing SSH sessions

### Data Flow

1. **Claude Code Command**: `ssh_exec` → MCP Server → SSH Manager → Queue → SSH Session
2. **Browser Command**: Terminal Input → WebSocket → Web Server → SSH Manager → Queue → SSH Session
3. **Output Streaming**: SSH Session → SSH Manager → WebSocket → Browser Terminal
4. **State Updates**: Command completion → Terminal unlock (for user commands only)

## Troubleshooting

### Common Issues

**Server not starting after registration:**
```bash
# Check if Claude Code recognizes the server
claude mcp list

# Verify build exists
ls -la dist/src/mcp-server.js

# Test the server directly
node dist/src/mcp-server.js
```

**Port conflicts:**
```bash
# Re-run installation to discover new port
./install-mcp.sh

# Verify new configuration
claude mcp get ssh
```

**SSH connection failures:**
- Verify SSH server is running and accessible
- Check credentials (username/password or privateKey)
- Ensure SSH server allows password authentication if using passwords

**Web interface not accessible:**
- Use `ssh_get_monitoring_url` to get the correct URL with current port
- Check that the server is running: `ps aux | grep mcp-server`

### Logs and Debugging

```bash
# Enable debug logging when using Claude Code
export LOG_LEVEL=debug

# Check MCP server configuration
claude mcp get ssh

# Test server manually with debug output
LOG_LEVEL=debug node dist/src/mcp-server.js
```


## License

MIT License - see [LICENSE](LICENSE) file for details.
