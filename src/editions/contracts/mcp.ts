import type { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "@/lib/mcp/oauth";
export type EditionMcpPermission = { id:string; title:string; detail:string; requiresWorkspace?:boolean };
/** Serializable configuration, safe in consent clients. No server implementation here. */
export type EditionMcpConfig = {
 permissions:readonly EditionMcpPermission[];
 consent?:{className?:string;images?:readonly {src:string;alt:string}[]};
};
export type EditionMcpServer = {
 instructions?:string;
 canReadAsset?(principal:McpPrincipal,projectId:string,assetId:string):Promise<boolean>;
 register(server:McpServer,principal:McpPrincipal,origin:string):void;
};
