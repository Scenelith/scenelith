type NumberedNodeData = { kind?: string; mediaType?: string; createdAt?: string; nodeNumber?: number; nodeNumberType?: string };
export function canvasNodeType(data: NumberedNodeData): string;
export function canvasNodeLabel(data: NumberedNodeData): string;
export function assignCanvasNodeNumbers<T extends { id: string; data: NumberedNodeData }>(nodes: T[], previous?: T[]): T[];
