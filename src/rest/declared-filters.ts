import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, QueryFilter } from "@pragmatic-tech-ai/todl";

/** One declared server-side filter: equality on `Field` is sent as the source's `Target` parameter/argument. */
export interface DeclaredFilter
{
    readonly Field: string;
    readonly Target: string;
    /** GraphQL argument type (e.g. `String`, `ID!`); absent for REST query params. */
    readonly Type?: string;
}

/** A declared filter bound to the value one request asks for. */
export interface PushedFilter
{
    readonly Filter: DeclaredFilter;
    readonly Value: ExternalFieldValue;
}

/**
 * Connector-declared server-side filters for REST / GraphQL, which have no generic filter language. A connection
 * declares, per source field, the query param (REST `filterParams = "region=region, tier=level"`) or query-field
 * argument with its type (GraphQL `filterArgs = "region=region:String"`) that filters by equality. Only Eq terms with a
 * non-null value are sent. A declared filter must be equality-or-wider on the server: the adapter always re-applies the
 * full Where in memory, so a wider server filter is harmless while a narrower one would drop rows.
 */
export class DeclaredFilters
{
    private static readonly EntrySeparator = /\s*,\s*/;
    private static readonly PairSeparator = "=";
    private static readonly TypeSeparator = ":";
    private static readonly NamePattern = /^[_A-Za-z][_0-9A-Za-z.-]*$/;
    private static readonly TypePattern = /^\[?[_A-Za-z][_0-9A-Za-z]*!?\]?!?$/;
    // GraphQL argument names (a REST query param may also carry '.' / '-').
    private static readonly GraphQlNamePattern = /^[_A-Za-z][_0-9A-Za-z]*$/;
    private static readonly MalformedMessage = "filter declaration must be 'field=target' entries separated by commas";
    private static readonly TypeRequiredMessage = "graphql filterArgs entries must be 'field=arg:Type'";

    private constructor(private readonly filters: readonly DeclaredFilter[])
    {
    }

    public static readonly None = new DeclaredFilters([]);

    /** Parses a declaration; `typed` requires (GraphQL) or forbids (REST) a `:Type` on each target. Empty/absent -> None. */
    public static Parse(raw: string | undefined, typed: boolean): DeclaredFilters
    {
        if (raw === undefined || raw.trim().length === 0) return DeclaredFilters.None;
        const filters = raw.trim().split(DeclaredFilters.EntrySeparator).filter(e => e.length > 0).map(entry =>
        {
            const [field, target, ...rest] = entry.split(DeclaredFilters.PairSeparator);
            if (field === undefined || target === undefined || rest.length > 0) throw new Error(DeclaredFilters.MalformedMessage);
            const [name, type, ...extra] = target.split(DeclaredFilters.TypeSeparator);
            if (!DeclaredFilters.NamePattern.test(field.trim()) || name === undefined || !DeclaredFilters.NamePattern.test(name.trim()) || extra.length > 0)
            {
                throw new Error(DeclaredFilters.MalformedMessage);
            }
            if (typed && (type === undefined || !DeclaredFilters.TypePattern.test(type.trim()))) throw new Error(DeclaredFilters.TypeRequiredMessage);
            if (typed && !DeclaredFilters.GraphQlNamePattern.test(name.trim())) throw new Error(DeclaredFilters.MalformedMessage);
            if (!typed && type !== undefined) throw new Error(DeclaredFilters.MalformedMessage);
            return typed ? { Field: field.trim(), Target: name.trim(), Type: type!.trim() } : { Field: field.trim(), Target: name.trim() };
        });
        return new DeclaredFilters(filters);
    }

    public get IsEmpty(): boolean
    {
        return this.filters.length === 0;
    }

    /** Every declared target (param / argument) name, in declaration order. */
    public Targets(): string[]
    {
        return this.filters.map(f => f.Target);
    }

    /** The declared argument for one source field, if any. */
    public For(field: string): DeclaredFilter | undefined
    {
        return this.filters.find(f => f.Field === field);
    }

    /** The declared filters this Where can drive: the first non-null Eq term per declared field. */
    public Pick(where: QueryFilter | undefined): PushedFilter[]
    {
        const out: PushedFilter[] = [];
        for (const filter of this.filters)
        {
            const term = (where?.All ?? []).find(t => t.Field === filter.Field && t.Op === QueryCompareOp.Eq && t.Value !== null);
            if (term !== undefined) out.push({ Filter: filter, Value: term.Value });
        }
        return out;
    }
}
