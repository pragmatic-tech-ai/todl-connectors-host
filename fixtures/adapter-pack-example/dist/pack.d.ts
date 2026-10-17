import type { IDataSourceAdapterFactory } from "@pragmatic-tech-ai/todl";
/** The pack's entry: a PLAIN object conforming structurally to `IAdapterPack`. No engine value is
 *  imported, so the worker duck-types this default export with the engine unresolved. */
declare const _default: {
    Factories(): readonly IDataSourceAdapterFactory[];
};
export default _default;
