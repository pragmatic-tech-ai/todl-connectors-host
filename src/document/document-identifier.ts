/** Validates Mongo collection / field names (Mongo has no identifier-quoting analog, so bad names are rejected). */
export class DocumentIdentifier
{
    private static readonly OperatorPrefix = "$";
    private static readonly PathSeparator = ".";
    private static readonly ControlChars = /[\u0000-\u001f]/;
    private static readonly InvalidMessage = "invalid document identifier";

    public static Validate(name: string): string
    {
        if (name.length === 0
            || DocumentIdentifier.ControlChars.test(name)
            || name.startsWith(DocumentIdentifier.OperatorPrefix)
            || name.includes(DocumentIdentifier.PathSeparator))
        {
            throw new Error(DocumentIdentifier.InvalidMessage);
        }
        return name;
    }
}
