/**
 * MCP client barrel.
 *
 * The split mirrors `generation/`: `protocol` is the wire format, `client` is one
 * connection, `manager` is the pool. The spawn call itself lives in
 * `src/main/mcp.ts`, because it is the only part that cannot be unit-tested.
 */

export {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  McpError,
  McpErrorCode,
  clipForLog,
  describeMcpError,
  encodeError,
  encodeMessage,
  encodeNotification,
  encodeRequest,
  isConnectionLost,
  parseLine,
  type JsonRpcErrorShape,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type McpIncoming,
} from "./protocol";

export {
  McpClient,
  type McpClientOptions,
  type McpClientState,
  type McpExit,
  type McpToolInfo,
  type McpToolResult,
  type McpTransport,
} from "./client";

export {
  McpManager,
  type McpManagerOptions,
  type McpServerSpec,
  type McpServerState,
} from "./manager";
