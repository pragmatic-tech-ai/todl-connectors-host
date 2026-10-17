import { ExampleSqlAdapterFactory } from "./example-sql-adapter.js";
/** The pack's entry: a PLAIN object conforming structurally to `IAdapterPack`. No engine value is
 *  imported, so the worker duck-types this default export with the engine unresolved. */
export default {
    Factories() {
        return [new ExampleSqlAdapterFactory()];
    }
};
