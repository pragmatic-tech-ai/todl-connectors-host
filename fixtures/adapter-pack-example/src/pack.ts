import { AdapterPack } from "@pragmatic-tech-ai/todl/adapter-pack";
import { ExampleSqlAdapterFactory } from "./example-sql-adapter.js";

export default AdapterPack.Of(new ExampleSqlAdapterFactory());
