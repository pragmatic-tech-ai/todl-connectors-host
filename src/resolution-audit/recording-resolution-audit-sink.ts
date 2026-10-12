import type { IResolutionAuditSink, ResolutionAuditEvent } from "@pragmatic-tech-ai/todl";

/** In-memory reference IResolutionAuditSink: collects every event the engine emits during connector Prepare,
 *  for consumers and tests. Carries only the names/node-ids the engine provides; nothing is logged. */
export class RecordingResolutionAuditSink implements IResolutionAuditSink
{
    private readonly events: ResolutionAuditEvent[] = [];

    public Record(event: ResolutionAuditEvent): Promise<void>
    {
        this.events.push(event);
        return Promise.resolve();
    }

    public Events(): readonly ResolutionAuditEvent[]
    {
        return this.events;
    }
}
