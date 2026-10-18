/** Shared write-failure reason strings for the REST-family adapters (REST, GraphQL), which both
 *  refuse a Transactional batch for the same reason: no cross-request backend transaction. One home
 *  for the text so the two adapters cannot drift. */
export class RestWriteReasons
{
    /** A Transactional batch is refused: these connectors have no cross-request transaction. */
    public static readonly TransactionUnsupported = "transactional write not supported by this connector";
}
