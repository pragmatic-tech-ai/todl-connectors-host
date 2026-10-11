/** Validates and backtick-escapes Cypher identifiers (labels, property names). */
export class CypherIdentifier
{
    private static readonly Backtick = "`";
    private static readonly EscapedBacktick = "``";
    private static readonly ControlChars = /[\u0000-\u001f]/;
    private static readonly InvalidMessage = "invalid cypher identifier";

    public static Validate(name: string): string
    {
        if (name.length === 0 || CypherIdentifier.ControlChars.test(name))
        {
            throw new Error(CypherIdentifier.InvalidMessage);
        }
        return name;
    }

    public static Quote(name: string): string
    {
        CypherIdentifier.Validate(name);
        const escaped = name.replaceAll(CypherIdentifier.Backtick, CypherIdentifier.EscapedBacktick);
        return CypherIdentifier.Backtick + escaped + CypherIdentifier.Backtick;
    }
}
