import { TablePanel } from '../../application/plotting/components/table-panel';
import type { WorkspaceLiveRendererContext } from './live-renderer-contract';
export function TableLiveRenderer({ liveContext }: { liveContext: WorkspaceLiveRendererContext }) { return <TablePanel binding={liveContext.binding} sessionId={liveContext.sessionId} />; }
